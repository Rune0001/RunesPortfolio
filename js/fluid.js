/* GPU fluid simulation — paint that follows the cursor.
   Semi-Lagrangian advection + vorticity confinement + Jacobi pressure solve.
   Renders behind the page content; degrades to nothing without WebGL. */

(function () {
  'use strict';

  var canvas = document.getElementById('fluid');
  if (!canvas) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var CONFIG = {
    SIM_RES: 128,            // velocity field resolution
    DYE_RES: 512,            // colour field resolution
    DENSITY_DISSIPATION: 1.1,
    VELOCITY_DISSIPATION: 0.3,
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 20,
    CURL: 26,                // swirliness
    SPLAT_RADIUS: 0.2,
    SPLAT_FORCE: 5200
  };

  /* ── context ──────────────────────────────────────────── */

  var params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
  var gl = canvas.getContext('webgl2', params);
  var isWebGL2 = !!gl;
  if (!isWebGL2) gl = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
  if (!gl) return;

  var halfFloat, supportLinear;

  if (isWebGL2) {
    gl.getExtension('EXT_color_buffer_float');
    supportLinear = !!gl.getExtension('OES_texture_float_linear');
  } else {
    halfFloat = gl.getExtension('OES_texture_half_float');
    supportLinear = !!gl.getExtension('OES_texture_half_float_linear');
    if (!halfFloat) return;
  }

  var halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;

  function supportRenderTextureFormat(internalFormat, format, type) {
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(texture);
    return ok;
  }

  function getSupportedFormat(internalFormat, format, type) {
    if (supportRenderTextureFormat(internalFormat, format, type)) {
      return { internalFormat: internalFormat, format: format };
    }
    if (!isWebGL2) return null;
    switch (internalFormat) {
      case gl.R16F:    return getSupportedFormat(gl.RG16F, gl.RG, type);
      case gl.RG16F:   return getSupportedFormat(gl.RGBA16F, gl.RGBA, type);
      default:         return null;
    }
  }

  var formatRGBA = isWebGL2
    ? getSupportedFormat(gl.RGBA16F, gl.RGBA, halfFloatTexType)
    : getSupportedFormat(gl.RGBA, gl.RGBA, halfFloatTexType);
  var formatRG = isWebGL2
    ? getSupportedFormat(gl.RG16F, gl.RG, halfFloatTexType)
    : formatRGBA;
  var formatR = isWebGL2
    ? getSupportedFormat(gl.R16F, gl.RED, halfFloatTexType)
    : formatRGBA;

  if (!formatRGBA) return;

  /* ── shader plumbing ──────────────────────────────────── */

  function compile(type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn(gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  }

  function Program(vs, fs) {
    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);

    this.uniforms = {};
    var count = gl.getProgramParameter(this.program, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < count; i++) {
      var name = gl.getActiveUniform(this.program, i).name;
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
  }
  Program.prototype.bind = function () { gl.useProgram(this.program); };

  var baseVertex = compile(gl.VERTEX_SHADER, [
    'precision highp float;',
    'attribute vec2 aPosition;',
    'varying vec2 vUv;',
    'varying vec2 vL;',
    'varying vec2 vR;',
    'varying vec2 vT;',
    'varying vec2 vB;',
    'uniform vec2 texelSize;',
    'void main () {',
    '  vUv = aPosition * 0.5 + 0.5;',
    '  vL = vUv - vec2(texelSize.x, 0.0);',
    '  vR = vUv + vec2(texelSize.x, 0.0);',
    '  vT = vUv + vec2(0.0, texelSize.y);',
    '  vB = vUv - vec2(0.0, texelSize.y);',
    '  gl_Position = vec4(aPosition, 0.0, 1.0);',
    '}'
  ].join('\n'));

  function frag(src) { return compile(gl.FRAGMENT_SHADER, 'precision highp float;\nprecision highp sampler2D;\n' + src); }

  var copyShader = frag([
    'varying vec2 vUv;',
    'uniform sampler2D uTexture;',
    'void main () { gl_FragColor = texture2D(uTexture, vUv); }'
  ].join('\n'));

  var clearShader = frag([
    'varying vec2 vUv;',
    'uniform sampler2D uTexture;',
    'uniform float value;',
    'void main () { gl_FragColor = value * texture2D(uTexture, vUv); }'
  ].join('\n'));

  /* paint injected at the cursor, falling off as a gaussian */
  var splatShader = frag([
    'varying vec2 vUv;',
    'uniform sampler2D uTarget;',
    'uniform float aspectRatio;',
    'uniform vec3 color;',
    'uniform vec2 point;',
    'uniform float radius;',
    'void main () {',
    '  vec2 p = vUv - point.xy;',
    '  p.x *= aspectRatio;',
    '  vec3 splat = exp(-dot(p, p) / radius) * color;',
    '  vec3 base = texture2D(uTarget, vUv).xyz;',
    '  gl_FragColor = vec4(base + splat, 1.0);',
    '}'
  ].join('\n'));

  /* trace velocity backwards in time and sample where it came from */
  var advectionShader = frag([
    'varying vec2 vUv;',
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uSource;',
    'uniform vec2 texelSize;',
    'uniform vec2 dyeTexelSize;',
    'uniform float dt;',
    'uniform float dissipation;',
    supportLinear ? '' : [
      'vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {',
      '  vec2 st = uv / tsize - 0.5;',
      '  vec2 iuv = floor(st);',
      '  vec2 fuv = fract(st);',
      '  vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);',
      '  vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);',
      '  vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);',
      '  vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);',
      '  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);',
      '}'
    ].join('\n'),
    'void main () {',
    supportLinear
      ? [
          '  vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;',
          '  vec4 result = texture2D(uSource, coord);'
        ].join('\n')
      : [
          '  vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;',
          '  vec4 result = bilerp(uSource, coord, dyeTexelSize);'
        ].join('\n'),
    '  float decay = 1.0 + dissipation * dt;',
    '  gl_FragColor = result / decay;',
    '}'
  ].join('\n'));

  var divergenceShader = frag([
    'varying vec2 vUv, vL, vR, vT, vB;',
    'uniform sampler2D uVelocity;',
    'void main () {',
    '  float L = texture2D(uVelocity, vL).x;',
    '  float R = texture2D(uVelocity, vR).x;',
    '  float T = texture2D(uVelocity, vT).y;',
    '  float B = texture2D(uVelocity, vB).y;',
    '  vec2 C = texture2D(uVelocity, vUv).xy;',
    '  if (vL.x < 0.0) { L = -C.x; }',
    '  if (vR.x > 1.0) { R = -C.x; }',
    '  if (vT.y > 1.0) { T = -C.y; }',
    '  if (vB.y < 0.0) { B = -C.y; }',
    '  gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n'));

  var curlShader = frag([
    'varying vec2 vUv, vL, vR, vT, vB;',
    'uniform sampler2D uVelocity;',
    'void main () {',
    '  float L = texture2D(uVelocity, vL).y;',
    '  float R = texture2D(uVelocity, vR).y;',
    '  float T = texture2D(uVelocity, vT).x;',
    '  float B = texture2D(uVelocity, vB).x;',
    '  gl_FragColor = vec4(R - L - T + B, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n'));

  /* pushes energy back into vortices the grid would otherwise smear away */
  var vorticityShader = frag([
    'varying vec2 vUv, vL, vR, vT, vB;',
    'uniform sampler2D uVelocity;',
    'uniform sampler2D uCurl;',
    'uniform float curl;',
    'uniform float dt;',
    'void main () {',
    '  float L = texture2D(uCurl, vL).x;',
    '  float R = texture2D(uCurl, vR).x;',
    '  float T = texture2D(uCurl, vT).x;',
    '  float B = texture2D(uCurl, vB).x;',
    '  float C = texture2D(uCurl, vUv).x;',
    '  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));',
    '  force /= length(force) + 0.0001;',
    '  force *= curl * C;',
    '  force.y *= -1.0;',
    '  vec2 velocity = texture2D(uVelocity, vUv).xy;',
    '  velocity += force * dt;',
    '  velocity = min(max(velocity, -1000.0), 1000.0);',
    '  gl_FragColor = vec4(velocity, 0.0, 1.0);',
    '}'
  ].join('\n'));

  var pressureShader = frag([
    'varying vec2 vUv, vL, vR, vT, vB;',
    'uniform sampler2D uPressure;',
    'uniform sampler2D uDivergence;',
    'void main () {',
    '  float L = texture2D(uPressure, vL).x;',
    '  float R = texture2D(uPressure, vR).x;',
    '  float T = texture2D(uPressure, vT).x;',
    '  float B = texture2D(uPressure, vB).x;',
    '  float divergence = texture2D(uDivergence, vUv).x;',
    '  float pressure = (L + R + B + T - divergence) * 0.25;',
    '  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);',
    '}'
  ].join('\n'));

  var gradientSubtractShader = frag([
    'varying vec2 vUv, vL, vR, vT, vB;',
    'uniform sampler2D uPressure;',
    'uniform sampler2D uVelocity;',
    'void main () {',
    '  float L = texture2D(uPressure, vL).x;',
    '  float R = texture2D(uPressure, vR).x;',
    '  float T = texture2D(uPressure, vT).x;',
    '  float B = texture2D(uPressure, vB).x;',
    '  vec2 velocity = texture2D(uVelocity, vUv).xy;',
    '  velocity.xy -= vec2(R - L, T - B);',
    '  gl_FragColor = vec4(velocity, 0.0, 1.0);',
    '}'
  ].join('\n'));

  /* alpha follows brightness so untouched areas stay fully transparent */
  var displayShader = frag([
    'varying vec2 vUv;',
    'uniform sampler2D uTexture;',
    'uniform float uIntensity;',
    'void main () {',
    '  vec3 c = texture2D(uTexture, vUv).rgb * uIntensity;',
    '  float a = max(c.r, max(c.g, c.b));',
    '  gl_FragColor = vec4(c, min(a, 1.0));',
    '}'
  ].join('\n'));

  var copyProgram = new Program(baseVertex, copyShader);
  var clearProgram = new Program(baseVertex, clearShader);
  var splatProgram = new Program(baseVertex, splatShader);
  var advectionProgram = new Program(baseVertex, advectionShader);
  var divergenceProgram = new Program(baseVertex, divergenceShader);
  var curlProgram = new Program(baseVertex, curlShader);
  var vorticityProgram = new Program(baseVertex, vorticityShader);
  var pressureProgram = new Program(baseVertex, pressureShader);
  var gradienSubtractProgram = new Program(baseVertex, gradientSubtractShader);
  var displayProgram = new Program(baseVertex, displayShader);

  /* ── full screen quad ─────────────────────────────────── */

  var blit = (function () {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);

    return function (target) {
      if (target == null) {
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      } else {
        gl.viewport(0, 0, target.width, target.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      }
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };
  })();

  /* ── framebuffers ─────────────────────────────────────── */

  var dye, velocity, divergence, curl, pressure;

  function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      texture: texture, fbo: fbo, width: w, height: h,
      texelSizeX: 1 / w, texelSizeY: 1 / h,
      attach: function (id) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      }
    };
  }

  function createDoubleFBO(w, h, internalFormat, format, type, param) {
    var fbo1 = createFBO(w, h, internalFormat, format, type, param);
    var fbo2 = createFBO(w, h, internalFormat, format, type, param);
    return {
      width: w, height: h, texelSizeX: fbo1.texelSizeX, texelSizeY: fbo1.texelSizeY,
      get read() { return fbo1; },
      set read(v) { fbo1 = v; },
      get write() { return fbo2; },
      set write(v) { fbo2 = v; },
      swap: function () { var t = fbo1; fbo1 = fbo2; fbo2 = t; }
    };
  }

  function getResolution(resolution) {
    var aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1 / aspect;
    var min = Math.round(resolution);
    var max = Math.round(resolution * aspect);
    if (gl.drawingBufferWidth > gl.drawingBufferHeight) return { width: max, height: min };
    return { width: min, height: max };
  }

  function initFramebuffers() {
    var simRes = getResolution(CONFIG.SIM_RES);
    var dyeRes = getResolution(CONFIG.DYE_RES);
    var texType = halfFloatTexType;
    var filtering = supportLinear ? gl.LINEAR : gl.NEAREST;

    gl.disable(gl.BLEND);

    dye = createDoubleFBO(dyeRes.width, dyeRes.height, formatRGBA.internalFormat, formatRGBA.format, texType, filtering);
    velocity = createDoubleFBO(simRes.width, simRes.height, formatRG.internalFormat, formatRG.format, texType, filtering);
    divergence = createFBO(simRes.width, simRes.height, formatR.internalFormat, formatR.format, texType, gl.NEAREST);
    curl = createFBO(simRes.width, simRes.height, formatR.internalFormat, formatR.format, texType, gl.NEAREST);
    pressure = createDoubleFBO(simRes.width, simRes.height, formatR.internalFormat, formatR.format, texType, gl.NEAREST);
  }

  function resizeCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.floor(canvas.clientWidth * dpr);
    var h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      return true;
    }
    return false;
  }

  resizeCanvas();
  initFramebuffers();

  /* ── simulation step ──────────────────────────────────── */

  var lastTime = Date.now();

  function step(dt) {
    gl.disable(gl.BLEND);

    curlProgram.bind();
    gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);

    vorticityProgram.bind();
    gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, CONFIG.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);

    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, CONFIG.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    for (var i = 0; i < CONFIG.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    gradienSubtractProgram.bind();
    gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    advectionProgram.bind();
    gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    if (!supportLinear) {
      gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    }
    var velocityId = velocity.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
    gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, CONFIG.VELOCITY_DISSIPATION);
    blit(velocity.write);
    velocity.swap();

    if (!supportLinear) {
      gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    }
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dissipation, CONFIG.DENSITY_DISSIPATION);
    blit(dye.write);
    dye.swap();
  }

  function render() {
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    displayProgram.bind();
    gl.uniform1i(displayProgram.uniforms.uTexture, dye.read.attach(0));
    gl.uniform1f(displayProgram.uniforms.uIntensity, 1.0);
    blit(null);
  }

  /* ── splats ───────────────────────────────────────────── */

  function splat(x, y, dx, dy, color) {
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(splatProgram.uniforms.radius, correctRadius(CONFIG.SPLAT_RADIUS / 100));
    blit(velocity.write);
    velocity.swap();

    gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
    blit(dye.write);
    dye.swap();
  }

  function correctRadius(radius) {
    var aspect = canvas.width / canvas.height;
    return aspect > 1 ? radius * aspect : radius;
  }

  /* blues and violets only — keeps the paint inside the site's palette */
  function paintColor() {
    var hue = 0.58 + Math.random() * 0.13;        // cyan-blue → indigo
    var c = HSVtoRGB(hue, 0.85, 1.0);
    c.r *= 0.16; c.g *= 0.16; c.b *= 0.19;
    return c;
  }

  function HSVtoRGB(h, s, v) {
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s);
    var q = v * (1 - f * s);
    var t = v * (1 - (1 - f) * s);
    var r, g, b;
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      default: r = v; g = p; b = q; break;
    }
    return { r: r, g: g, b: b };
  }

  /* ── pointer ──────────────────────────────────────────── */

  var pointer = { x: 0, y: 0, dx: 0, dy: 0, down: false, moved: false, color: paintColor() };
  var queue = [];

  function pushMove(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    var x = (clientX - rect.left) / rect.width;
    var y = 1.0 - (clientY - rect.top) / rect.height;

    pointer.dx = (x - pointer.x) * CONFIG.SPLAT_FORCE;
    pointer.dy = (y - pointer.y) * CONFIG.SPLAT_FORCE;
    pointer.x = x;
    pointer.y = y;

    if (Math.abs(pointer.dx) > 0 || Math.abs(pointer.dy) > 0) {
      queue.push({ x: x, y: y, dx: pointer.dx, dy: pointer.dy, color: pointer.color });
    }
  }

  window.addEventListener('mousemove', function (e) {
    pushMove(e.clientX, e.clientY);
  }, { passive: true });

  /* a new colour each time the cursor re-enters or clicks */
  window.addEventListener('mousedown', function () { pointer.color = paintColor(); });
  document.addEventListener('mouseenter', function () { pointer.color = paintColor(); });

  window.addEventListener('touchmove', function (e) {
    var t = e.targetTouches[0];
    if (t) pushMove(t.clientX, t.clientY);
  }, { passive: true });

  window.addEventListener('touchstart', function () { pointer.color = paintColor(); }, { passive: true });

  /* drift the hue over time so long sessions don't stay one colour */
  setInterval(function () { pointer.color = paintColor(); }, 6000);

  /* ── loop ─────────────────────────────────────────────── */

  function update() {
    var now = Date.now();
    var dt = Math.min((now - lastTime) / 1000, 0.016666);
    lastTime = now;

    if (resizeCanvas()) initFramebuffers();

    while (queue.length) {
      var s = queue.shift();
      splat(s.x, s.y, s.dx, s.dy, s.color);
    }

    step(dt);
    render();
    requestAnimationFrame(update);
  }

  update();
})();
