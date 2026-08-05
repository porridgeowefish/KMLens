const targets = await fetch("http://127.0.0.1:9224/json").then((response) => response.json());
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
      expression: `({
        fileLoaded: document.body.innerText.includes("desktop-smoke.gpx"),
        trackLoaded: document.body.innerText.includes("桌面版测试轨迹"),
        secondFileLoaded: document.body.innerText.includes("desktop-second.kml"),
        secondTrackLoaded: document.body.innerText.includes("第二条测试路线"),
        statsVisible: document.body.innerText.includes("总里程"),
        runtimeError: Boolean(document.querySelector("vite-error-overlay"))
      })`,
      returnByValue: true,
    },
  }));
});

socket.close();
console.log(JSON.stringify(result.result.result.value));
