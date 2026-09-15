/* minimal-weather-line-chart
 *
 * A stripped-down hourly forecast card for Home Assistant: a single
 * temperature line with the temperature, condition icon and (optionally)
 * wind speed sitting next to each point, and compact hour labels
 * underneath. No Chart.js, no datalabels plugin, no canvas.
 *
 * Forked from mlamberts78/weather-chart-card. See README.md for the
 * reasoning behind each change.
 */

const CARD_TAG = "minimal-weather-line-chart";
const CARD_VERSION = "1.0.0";

const CONDITION_ICONS = {
  "clear-night": "weather-night",
  cloudy: "weather-cloudy",
  fog: "weather-fog",
  hail: "weather-hail",
  lightning: "weather-lightning",
  "lightning-rainy": "weather-lightning-rainy",
  partlycloudy: "weather-partly-cloudy",
  pouring: "weather-pouring",
  rainy: "weather-rainy",
  snowy: "weather-snowy",
  "snowy-rainy": "weather-snowy-rainy",
  sunny: "weather-sunny",
  windy: "weather-windy",
  "windy-variant": "weather-windy-variant",
  exceptional: "alert-circle-outline",
};

// Used when the forecast entry says is_daytime === false.
const NIGHT_ICONS = {
  sunny: "weather-night",
  partlycloudy: "weather-night-partly-cloudy",
};

const DEFAULTS = {
  hours: 12, // maximum number of hours shown
  until_midnight: false, // only show hours before the next local midnight (still capped by `hours`)
  show_wind: false,
  hide_repeats: false,
  show_separators: null, // null -> follows hide_repeats
  stagger_labels: true, // lift a label one row when it would overlap its left neighbour
  chart_height: 84, // px, the line area (hour row is added below it)
  padding_top: null, // px above the highest point; null -> just enough for the labels
  padding_bottom: 4, // px between the lowest point and the hour row
  padding_x: 8, // px card side padding
  line_color: "rgba(255, 152, 0, 1)",
  line_width: 2,
  separator_color: "var(--divider-color, rgba(128, 128, 128, 0.4))",
  background: "transparent",
  radius: 0,
};

const STYLE_DEFAULTS = {
  temperature: { size: 14, color: "var(--primary-text-color)", bg: "transparent" },
  hour: { size: 11, color: "var(--secondary-text-color)", bg: "transparent", format: "12h" },
  wind_speed: { size: 11, color: "var(--primary-text-color)", bg: "transparent" },
  wind_unit: { size: 9, color: "var(--secondary-text-color)", bg: "transparent", label: null },
  condition_icon: { size: 18, color: "var(--primary-text-color)", bg: "transparent" },
};

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

class MinimalWeatherLineChart extends HTMLElement {
  static getStubConfig(hass) {
    const first = hass && hass.states ? Object.keys(hass.states).find((id) => id.indexOf("weather.") === 0) : null;
    return { entity: first || "weather.home", hide_repeats: true };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._forecast = null;
    this._sub = null;
    this._error = null;
    this._lastKey = null;
    this._resizeObserver = null;
  }

  setConfig(config) {
    if (!config || !config.entity) throw new Error(CARD_TAG + ": 'entity' is required");
    const merged = Object.assign({}, DEFAULTS, config);
    Object.keys(STYLE_DEFAULTS).forEach((k) => {
      merged[k] = Object.assign({}, STYLE_DEFAULTS[k], config[k] || {});
    });
    merged.hours = Math.max(1, Math.floor(num(merged.hours, DEFAULTS.hours)));
    merged.chart_height = num(merged.chart_height, DEFAULTS.chart_height);
    merged.line_width = num(merged.line_width, DEFAULTS.line_width);
    merged.padding_bottom = num(merged.padding_bottom, DEFAULTS.padding_bottom);
    merged.padding_x = num(merged.padding_x, DEFAULTS.padding_x);
    merged.radius = num(merged.radius, DEFAULTS.radius);
    merged.padding_top = merged.padding_top == null ? null : num(merged.padding_top, null);
    if (merged.show_separators == null) merged.show_separators = !!merged.hide_repeats;

    const entityChanged = !this._config || this._config.entity !== merged.entity;
    this._config = merged;
    this._lastKey = null;
    if (entityChanged) {
      this._unsubscribe();
      this._forecast = null;
      this._error = null;
      if (this._hass && this.isConnected) this._subscribe();
    }
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._config && !this._sub && this.isConnected) this._subscribe();
    this._render();
  }

  connectedCallback() {
    if (this._hass && this._config && !this._sub) this._subscribe();
    if (!this._resizeObserver && typeof ResizeObserver !== "undefined") {
      // Label staggering depends on the card width, so re-layout on resize.
      this._resizeObserver = new ResizeObserver(() => {
        this._lastKey = null;
        this._render();
      });
      this._resizeObserver.observe(this);
    }
  }

  disconnectedCallback() {
    this._unsubscribe();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
  }

  getCardSize() {
    return 2;
  }

  _subscribe() {
    const entity = this._config.entity;
    let promise;
    try {
      promise = this._hass.connection.subscribeMessage(
        (ev) => {
          this._forecast = (ev && ev.forecast) || [];
          this._error = null;
          this._render();
        },
        { type: "weather/subscribe_forecast", forecast_type: "hourly", entity_id: entity }
      );
    } catch (e) {
      promise = Promise.reject(e);
    }
    this._sub = promise;
    promise.catch((err) => {
      if (this._sub === promise) this._sub = null;
      this._error = (err && err.message) || "Hourly forecast is not available for " + entity;
      this._render();
    });
  }

  _unsubscribe() {
    const promise = this._sub;
    this._sub = null;
    if (promise) {
      promise
        .then((unsub) => {
          if (typeof unsub === "function") unsub();
        })
        .catch(() => {});
    }
  }

  _formatHour(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const h = d.getHours();
    const m = d.getMinutes();
    const mm = m ? ":" + String(m).padStart(2, "0") : "";
    if (this._config.hour.format === "24h") return String(h).padStart(2, "0") + (mm || ":00");
    const h12 = h % 12 || 12;
    return h12 + mm + (h >= 12 ? "pm" : "am");
  }

  _iconFor(entry) {
    const cond = entry.condition;
    if (entry.is_daytime === false && NIGHT_ICONS[cond]) return "mdi:" + NIGHT_ICONS[cond];
    return "mdi:" + (CONDITION_ICONS[cond] || "weather-cloudy");
  }

  // Greedy collision pass over the rendered labels: each label takes the
  // lowest row (0 = directly above its point) where it does not overlap an
  // already placed label. Returns one row index per forecast entry.
  _measureLabelRows(rowHeight, count) {
    const rows = new Array(count).fill(0);
    const placed = [];
    const els = this.shadowRoot.querySelectorAll(".label");
    for (let k = 0; k < els.length; k++) {
      const el = els[k];
      const i = Number(el.getAttribute("data-i"));
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      let row = 0;
      for (; row < 4; row++) {
        const top = r.top - row * rowHeight;
        const bottom = r.bottom - row * rowHeight;
        const hit = placed.some((p) => r.left < p.right - 1 && r.right > p.left + 1 && top < p.bottom && bottom > p.top);
        if (!hit) break;
      }
      if (row === 4) row = 0;
      rows[i] = row;
      placed.push({ left: r.left, right: r.right, top: r.top - row * rowHeight, bottom: r.bottom - row * rowHeight });
    }
    return rows;
  }

  _render(labelRows) {
    if (!this._config) return;
    const c = this._config;
    const T = c.temperature;
    const HR = c.hour;
    const W = c.wind_speed;
    const WU = c.wind_unit;
    const CI = c.condition_icon;

    const state = this._hass && this._hass.states ? this._hass.states[c.entity] : null;
    let forecast = (this._forecast || []).filter((f) => f && f.temperature != null && f.datetime);
    if (c.until_midnight) {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      forecast = forecast.filter((f) => new Date(f.datetime).getTime() < midnight);
    }
    forecast = forecast.slice(0, c.hours);
    const unit =
      WU.label != null
        ? String(WU.label)
        : (state && state.attributes && state.attributes.wind_speed_unit) || "";

    let message = null;
    if (this._hass && !state) message = "Entity " + c.entity + " not found";
    else if (this._error) message = this._error;

    // Skip the DOM rebuild when nothing that affects the output changed.
    // `hass` is set on every state change in Home Assistant, which is often.
    const key = JSON.stringify([
      forecast.map((f) => [f.datetime, f.temperature, f.condition, f.wind_speed, f.is_daytime]),
      unit,
      message,
    ]);
    if (key === this._lastKey) return;
    this._lastKey = key;

    const n = forecast.length;
    const H = c.chart_height;
    const hoursH = HR.size + 6;
    const labelH = Math.max(CI.size, T.size, c.show_wind ? W.size : 0) + 2;
    const rowH = labelH + 2;
    const rows = labelRows || [];
    const maxRow = rows.reduce((m, r) => Math.max(m, r), 0);
    // Extra label rows (from staggering) grow the card rather than squeeze the line.
    const extraH = maxRow * rowH;
    const padTop = (c.padding_top == null ? labelH + 4 + c.line_width : c.padding_top) + extraH;
    const padBottom = c.padding_bottom;
    const innerH = Math.max(4, H + extraH - padTop - padBottom);
    const totalH = H + extraH + hoursH;

    const temps = forecast.map((f) => Math.round(f.temperature));
    const min = n ? Math.min.apply(null, temps) : 0;
    const max = n ? Math.max.apply(null, temps) : 0;
    const span = max - min;
    const colW = n ? 100 / n : 100;
    const yOf = (t) => (span === 0 ? padTop + innerH / 2 : padTop + ((max - t) / span) * innerH);
    const points = temps.map((t, i) => ({ x: colW * (i + 0.5), y: yOf(t) }));

    let svg = "";
    let labels = "";
    let hours = "";
    if (n) {
      let separators = "";
      if (c.show_separators) {
        for (let i = 1; i < n; i++) {
          if (forecast[i].condition !== forecast[i - 1].condition) {
            const x = (colW * i).toFixed(3);
            separators +=
              '<line x1="' + x + '" y1="0" x2="' + x + '" y2="' + totalH + '" stroke="' + c.separator_color +
              '" stroke-width="1" vector-effect="non-scaling-stroke"/>';
          }
        }
      }
      const poly = points.map((p) => p.x.toFixed(3) + "," + p.y.toFixed(2)).join(" ");
      svg =
        '<svg class="chart" viewBox="0 0 100 ' + totalH + '" preserveAspectRatio="none" aria-hidden="true">' +
        separators +
        '<polyline points="' + poly + '" fill="none" stroke="' + c.line_color + '" stroke-width="' + c.line_width +
        '" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>' +
        "</svg>";

      for (let i = 0; i < n; i++) {
        const f = forecast[i];
        const prev = i > 0 ? forecast[i - 1] : null;
        const wind = f.wind_speed != null ? Math.round(f.wind_speed) : null;
        const prevWind = prev && prev.wind_speed != null ? Math.round(prev.wind_speed) : null;
        const showCond = !c.hide_repeats || !prev || f.condition !== prev.condition;
        const showTemp = !c.hide_repeats || !prev || temps[i] !== temps[i - 1];
        const showWind = c.show_wind && wind != null && (!c.hide_repeats || !prev || wind !== prevWind);

        let inner = "";
        if (showCond) inner += '<ha-icon class="icon" icon="' + this._iconFor(f) + '"></ha-icon>';
        if (showTemp) inner += '<span class="temp">' + temps[i] + "°</span>";
        if (showWind) {
          inner += '<span class="wind">' + wind + '<span class="wind-unit">' + escapeHtml(unit) + "</span></span>";
        }
        if (inner) {
          const y = points[i].y - (rows[i] || 0) * rowH;
          labels +=
            '<div class="label" data-i="' + i + '" style="left:' + points[i].x.toFixed(3) + "%;top:" + y.toFixed(2) + 'px;">' +
            inner +
            "</div>";
        }
        hours += '<div class="hour" style="left:' + points[i].x.toFixed(3) + '%;">' + this._formatHour(f.datetime) + "</div>";
      }
    }

    const style =
      "<style>" +
      "ha-card{background:" + c.background + ";border:none;box-shadow:none;border-radius:" + c.radius + "px;" +
      "padding:0 " + c.padding_x + "px;overflow:visible;}" +
      ".wrap{position:relative;width:100%;height:" + totalH + "px;}" +
      ".chart{position:absolute;left:0;top:0;width:100%;height:" + totalH + "px;overflow:visible;display:block;}" +
      ".label{position:absolute;transform:translate(-50%,calc(-100% - 4px));display:flex;align-items:center;gap:3px;" +
      "white-space:nowrap;line-height:1;pointer-events:none;}" +
      ".icon{--mdc-icon-size:" + CI.size + "px;width:" + CI.size + "px;height:" + CI.size + "px;color:" + CI.color + ";" +
      "background:" + CI.bg + ";border-radius:4px;display:flex;align-items:center;justify-content:center;}" +
      ".temp{font-size:" + T.size + "px;color:" + T.color + ";background:" + T.bg + ";border-radius:4px;padding:1px 2px;font-weight:600;}" +
      ".wind{font-size:" + W.size + "px;color:" + W.color + ";background:" + W.bg + ";border-radius:4px;padding:1px 2px;" +
      "display:inline-flex;align-items:baseline;gap:1px;}" +
      ".wind-unit{font-size:" + WU.size + "px;color:" + WU.color + ";background:" + WU.bg + ";border-radius:3px;}" +
      ".hours{position:absolute;left:0;right:0;bottom:0;height:" + hoursH + "px;}" +
      ".hour{position:absolute;bottom:0;transform:translateX(-50%);line-height:1.2;white-space:nowrap;" +
      "font-size:" + HR.size + "px;color:" + HR.color + ";background:" + HR.bg + ";border-radius:4px;padding:0 2px;}" +
      ".message{font-size:12px;color:var(--secondary-text-color);padding:8px 0;}" +
      "</style>";

    const body = message
      ? '<div class="message">' + escapeHtml(message) + "</div>"
      : '<div class="wrap">' + svg + '<div class="labels">' + labels + '</div><div class="hours">' + hours + "</div></div>";

    this.shadowRoot.innerHTML = style + "<ha-card>" + body + "</ha-card>";

    if (n && c.stagger_labels && !labelRows && this.isConnected) {
      const measured = this._measureLabelRows(rowH, n);
      if (measured.some((r) => r > 0)) {
        this._lastKey = null;
        this._render(measured);
      }
    }
  }
}

if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, MinimalWeatherLineChart);

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: "Minimal Weather Line Chart",
  preview: true,
  description:
    "Hourly temperature line with the condition icon and optional wind next to each temperature, " +
    "compact hour labels, optional hiding of repeated values with group separators, and per-element styling.",
});

console.info(
  "%c " + CARD_TAG + " %c v" + CARD_VERSION + " ",
  "background:#ff9800;color:#000;font-weight:700;border-radius:3px 0 0 3px;padding:1px 5px",
  "background:#333;color:#fff;border-radius:0 3px 3px 0;padding:1px 5px"
);
