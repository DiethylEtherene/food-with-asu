# Food with Asu

A shared cookbook and meal planner: weekly plans with optional meal prep, a pantry-aware shopping list, and a hands-free cook mode with tap-to-start timers.

**Open it:** https://diethyletherene.github.io/food-with-asu/

- **Cook together.** Tap **Share** → **Start a kitchen** to get a code. Anyone who enters it shares the plan, pantry, shopping list and saved recipes, live.
- **Connect Claude.** In a kitchen, the **Kitchen** panel gives a connector URL. Add it in Claude (Settings → Connectors → Add custom connector) and Claude can find and write recipes, plan the week and update the pantry, on your own Claude account.
- Works offline once opened, and can be installed to a phone's home screen.

Recipes adapted from creators' videos credit the creator and link to the original.

## How it's built

| Part | What it is |
|---|---|
| `src/app.html` | The app: one HTML file, plain JS, no framework. |
| `web/kitchen.js` | Kitchen codes and live sync for the web version. |
| `build.py` | Builds `docs/` (served by GitHub Pages) from the two above. |
| `worker/` | Cloudflare Worker: one Durable Object per kitchen (storage + websocket sync), and the Claude connector (an MCP server at `/mcp/<kitchen code>`). |

```bash
python build.py https://food-with-asu.food-with-asu-worker.workers.dev   # rebuild the site
cd worker && npx wrangler deploy                                         # deploy the backend
node extract-recipes.mjs                                                 # after editing recipes in src/app.html
```
