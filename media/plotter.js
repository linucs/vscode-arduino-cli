// @ts-nocheck
/* eslint-disable */
/**
 * Serial plotter webview script. Receives telemetry data from the extension via
 * postMessage and renders it with uPlot. Supports multi-series time-series,
 * XY scatter, pause/resume/clear, and CSV export.
 */
(function () {
  const vscode = acquireVsCodeApi();
  const MAX_POINTS = 2000;

  // --- theme-aware colors ---
  const PALETTE = [
    "#4dc9f6", "#f67019", "#f53794", "#537bc4",
    "#acc236", "#166a8f", "#00a950", "#58595b",
    "#8549ba", "#e6194b", "#3cb44b", "#ffe119",
  ];

  function axisStroke() {
    return getComputedStyle(document.body).getPropertyValue("--vscode-foreground") || "#ccc";
  }
  function gridStroke() {
    return (getComputedStyle(document.body).getPropertyValue("--vscode-editorWidget-border") || "#333") + "40";
  }

  // --- state ---
  let paused = false;
  /** @type {Map<string, number>} series name → index in data arrays */
  const seriesMap = new Map();
  /** @type {number[][]} uPlot columnar data: [timestamps, ...seriesValues] */
  let tsData = [[]];
  /** @type {uPlot | null} */
  let tsChart = null;
  /** @type {Map<string, {x:number[],y:number[]}>} XY datasets keyed by "nameX:nameY" */
  const xyDatasets = new Map();
  /** @type {Map<string, uPlot>} */
  const xyCharts = new Map();

  /** Baseline timestamp (first data point) so the X axis shows relative seconds. */
  let t0 = 0;

  const chartsEl = document.getElementById("charts");
  const tsContainer = document.getElementById("ts-chart");
  const xyContainer = document.getElementById("xy-charts");
  const pauseBtn = document.getElementById("btn-pause");
  const statusEl = document.getElementById("status");
  const disconnectedEl = document.getElementById("disconnected");
  const timeFormatSel = document.getElementById("time-format");

  function formatTime(t) {
    const fmt = timeFormatSel.value;
    if (fmt === "elapsed") {
      const rel = t - t0;
      const m = Math.floor(rel / 60);
      const s = rel - m * 60;
      return String(m).padStart(2, "0") + ":" + s.toFixed(1).padStart(4, "0");
    }
    if (fmt === "clock") {
      const d = new Date(t * 1000);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    return (t - t0).toFixed(1) + "s";
  }

  function tsChartHeight() {
    // The container is a flex child that gets exactly the space left after the
    // toolbar. Subtract the legend height (which uPlot renders outside the canvas)
    // so the total fits without scrolling.
    const legendEl = tsContainer.querySelector(".u-legend");
    const legendH = legendEl ? legendEl.offsetHeight : 30;
    return Math.max(150, tsContainer.clientHeight - legendH);
  }

  // --- time-series chart setup ---
  function createTsChart() {
    const opts = {
      width: tsContainer.clientWidth - 16,
      height: tsChartHeight(),
      cursor: {
        show: true,
        lock: true,
        drag: { x: true, y: false, setScale: true },
      },
      legend: { show: true, live: true },
      scales: { x: { time: false } },
      axes: [
        {
          stroke: axisStroke,
          grid: { stroke: gridStroke },
          values: (u, vals) => vals.map(formatTime),
        },
        { stroke: axisStroke, grid: { stroke: gridStroke } },
      ],
      series: [{ label: "Time", value: (u, v) => v == null ? "—" : formatTime(v) }],
      hooks: {
        init: [u => {
          u.over.addEventListener("dblclick", () => {
            u.setScale("x", { min: tsData[0][0], max: tsData[0][tsData[0].length - 1] });
          });
        }],
      },
    };
    tsChart = new uPlot(opts, tsData, tsContainer);
  }

  function addTsSeries(name) {
    const idx = tsData.length;
    seriesMap.set(name, idx);
    // Backfill with nulls for existing timestamps
    tsData.push(new Array(tsData[0].length).fill(null));
    const color = PALETTE[(idx - 1) % PALETTE.length];
    tsChart.addSeries({ label: name, stroke: color, width: 1.5 }, idx);
    tsChart.setData(tsData);
    // Legend grew — shrink the canvas so the total still fits.
    tsChart.setSize({ width: tsContainer.clientWidth - 16, height: tsChartHeight() });
  }

  // --- XY chart setup ---
  function getOrCreateXyChart(key) {
    if (xyCharts.has(key)) return xyCharts.get(key);
    const div = document.createElement("div");
    div.className = "chart-container";
    const h = document.createElement("h3");
    h.textContent = key + " (XY)";
    div.appendChild(h);
    xyContainer.appendChild(div);

    const dataset = { x: [], y: [] };
    xyDatasets.set(key, dataset);

    const color = PALETTE[xyCharts.size % PALETTE.length];
    const opts = {
      width: xyContainer.clientWidth - 16,
      height: 250,
      mode: 2, // scatter mode
      cursor: { show: true },
      legend: { show: true },
      scales: { x: { time: false }, y: {} },
      axes: [
        { label: key.split(":")[0], stroke: axisStroke, grid: { stroke: gridStroke } },
        { label: key.split(":")[1], stroke: axisStroke, grid: { stroke: gridStroke } },
      ],
      series: [
        {},
        {
          label: key,
          stroke: color,
          fill: color + "40",
          paths: () => null, // scatter: no connecting lines
          points: { show: true, size: 4, fill: color },
        },
      ],
    };
    const chart = new uPlot(opts, [[], []], div);
    xyCharts.set(key, chart);
    return chart;
  }

  // --- data handling ---
  function handleData(points) {
    if (paused) return;

    let tsUpdated = false;

    for (const p of points) {
      if (p.type === "value") {
        const { name, value, timestamp } = p.point;
        const t = timestamp != null ? timestamp / 1000 : Date.now() / 1000;
        if (t0 === 0) t0 = t;

        if (!seriesMap.has(name)) {
          addTsSeries(name);
        }
        const idx = seriesMap.get(name);

        // Append timestamp
        tsData[0].push(t);
        for (let i = 1; i < tsData.length; i++) {
          tsData[i].push(i === idx ? value : null);
        }
        tsUpdated = true;
      } else if (p.type === "xy") {
        const { nameX, nameY, x, y } = p.point;
        const key = nameX + ":" + nameY;
        const chart = getOrCreateXyChart(key);
        const dataset = xyDatasets.get(key);
        dataset.x.push(x);
        dataset.y.push(y);
        // Trim
        if (dataset.x.length > MAX_POINTS) {
          const excess = dataset.x.length - MAX_POINTS;
          dataset.x.splice(0, excess);
          dataset.y.splice(0, excess);
        }
        chart.setData([dataset.x, dataset.y]);
      }
    }

    if (tsUpdated) {
      // Trim old points
      if (tsData[0].length > MAX_POINTS) {
        const excess = tsData[0].length - MAX_POINTS;
        for (let i = 0; i < tsData.length; i++) {
          tsData[i].splice(0, excess);
        }
      }
      tsChart.setData(tsData);
      statusEl.textContent = tsData[0].length + " pts";
    }
  }

  // --- controls ---
  const iconPause = document.getElementById("icon-pause");
  const iconResume = document.getElementById("icon-resume");
  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    iconPause.style.display = paused ? "none" : "";
    iconResume.style.display = paused ? "" : "none";
    pauseBtn.title = paused ? "Resume" : "Pause";
    pauseBtn.classList.toggle("active", paused);
  });

  document.getElementById("btn-clear").addEventListener("click", () => {
    tsData = [[]];
    seriesMap.clear();
    t0 = 0;
    if (tsChart) {
      tsChart.destroy();
      tsChart = null;
    }
    createTsChart();
    xyDatasets.clear();
    for (const [, chart] of xyCharts) chart.destroy();
    xyCharts.clear();
    xyContainer.innerHTML = "";
    statusEl.textContent = "0 pts";
  });

  document.getElementById("btn-export").addEventListener("click", () => {
    const rows = [];
    // Header
    const names = ["time", ...seriesMap.keys()];
    rows.push(names.join(","));
    // Rows
    for (let i = 0; i < tsData[0].length; i++) {
      const row = [tsData[0][i]];
      for (let s = 1; s < tsData.length; s++) {
        row.push(tsData[s][i] != null ? tsData[s][i] : "");
      }
      rows.push(row.join(","));
    }
    // XY datasets
    for (const [key, ds] of xyDatasets) {
      rows.push("");
      rows.push(key.replace(":", ",") + " (XY)");
      rows.push("x,y");
      for (let i = 0; i < ds.x.length; i++) {
        rows.push(ds.x[i] + "," + ds.y[i]);
      }
    }
    vscode.postMessage({ type: "exportCsv", csv: rows.join("\n") });
  });

  timeFormatSel.addEventListener("change", () => {
    if (tsChart) tsChart.setData(tsData);
  });

  // --- message handling ---
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "data") {
      disconnectedEl.classList.remove("visible");
      handleData(msg.points);
    } else if (msg.type === "disconnected") {
      disconnectedEl.classList.add("visible");
    } else if (msg.type === "connected") {
      disconnectedEl.classList.remove("visible");
    }
  });

  // --- resize ---
  const resizeObserver = new ResizeObserver(() => {
    const w = tsContainer.clientWidth - 16;
    if (tsChart && w > 0) tsChart.setSize({ width: w, height: tsChartHeight() });
    for (const [, chart] of xyCharts) {
      chart.setSize({ width: xyContainer.clientWidth - 16, height: 250 });
    }
  });
  resizeObserver.observe(chartsEl);

  // --- init ---
  createTsChart();
})();
