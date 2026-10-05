"""Fetch live Roblox stats and write stats.json (run by the GitHub Action)."""
import json, urllib.request

GAMES = {
    "anime-evolve": 10765591030,
    "marked": 8055845148,
}

url = "https://games.roblox.com/v1/games?universeIds=" + ",".join(map(str, GAMES.values()))
with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "portfolio-stats"}), timeout=30) as r:
    rows = {g["id"]: g for g in json.load(r)["data"]}

out = {}
for key, uid in GAMES.items():
    g = rows[uid]
    out[key] = {"visits": g["visits"], "favorites": g["favoritedCount"]}

with open("stats.json", "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
print(out)
