const port = process.argv[2] ?? "9225";
const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error("Desktop renderer target was not found");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const result = await new Promise((resolve, reject) => {
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === 1) resolve(message);
  });
  socket.addEventListener("error", reject, { once: true });
  socket.send(JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `(() => {
        const text = document.body.innerText;
        const tiles = Array.from(document.querySelectorAll(".leaflet-tile"));
        return {
          fileLoaded: text.includes("鲲鹏经11段.kml"),
          featureCountCorrect: text.includes("3 个要素"),
          coordinateCountCorrect: text.includes("2,183 个坐标"),
          distanceVisible: text.includes("13.43"),
          durationVisible: text.includes("2时 43分"),
          tileElements: tiles.length,
          loadedTiles: tiles.filter((tile) => tile.complete && tile.naturalWidth > 0).length,
          tileHost: tiles[0] ? new URL(tiles[0].src).host : null,
          statsText: document.querySelector(".stats-grid")?.innerText ?? null,
          datasets: Array.from(document.querySelectorAll(".dataset-info"))
            .map((item) => item.innerText),
          runtimeError: Boolean(document.querySelector("vite-error-overlay"))
        };
      })()`,
      returnByValue: true,
    },
  }));
});

socket.close();
console.log(JSON.stringify(result.result.result.value));
