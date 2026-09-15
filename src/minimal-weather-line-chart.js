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
const EDITOR_TAG = "minimal-weather-line-chart-editor";
const CARD_VERSION = "1.2.0";

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
  show_repeated_condition: false, // show the condition icon even when it is the same as the previous hour
  show_repeated_temperature: false, // same, for the temperature
  show_repeated_wind: false, // same, for the wind speed
  show_separators: true, // thin vertical line wherever the condition changes
  shrink_to_fit: true, // shrink label fonts until neighbouring labels no longer overlap
  hours_next_to_line: true, // hour label directly under each point instead of a row at the bottom
  chart_height: 84, // px, the line area including label room (a bottom hour row is added below it)
  padding_top: null, // px above the highest point; null -> just enough for the labels
  padding_bottom: 5, // px card padding below the lowest content
  padding_x: 8, // px card side padding
  line_color: "rgba(255, 152, 0, 1)",
  line_width: 2,
  dot_size: null, // px radius of the dot at each data point; null -> line_width + 2
  dot_color: null, // null -> line_color
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
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

class MinimalWeatherLineChart extends HTMLElement {
  static getStubConfig(hass) {
    const first = hass && hass.states ? Object.keys(hass.states).find((id) => id.indexOf("weather.") === 0) : null;
    return { entity: first || "weather.home" };
  }

  static async getConfigElement() {
    // ha-form and the selectors it needs are lazy-loaded by Home Assistant. Loading a
    // built-in card editor first guarantees they are defined before ours renders.
    if (!customElements.get("ha-form") && window.loadCardHelpers) {
      try {
        const helpers = await window.loadCardHelpers();
        const probe = helpers.createCardElement({ type: "entities", entities: [] });
        if (probe && probe.constructor && probe.constructor.getConfigElement) await probe.constructor.getConfigElement();
      } catch (e) {
        /* fall through: ha-form is usually already defined by then */
      }
    }
    return document.createElement(EDITOR_TAG);
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
    this._lastSize = null;
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
    merged.dot_size = Math.max(0, num(merged.dot_size, merged.line_width + 2));
    merged.dot_color = merged.dot_color || merged.line_color;
    merged.show_separators = merged.show_separators !== false;
    merged.shrink_to_fit = merged.shrink_to_fit !== false;

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
      // Whether labels fit (and so how much text shrinks) depends on the card size, so re-layout on resize.
      this._resizeObserver = new ResizeObserver((entries) => {
        const box = entries[0] && entries[0].contentRect;
        const size = box ? Math.round(box.width) + "x" + Math.round(box.height) : "";
        if (size === this._lastSize) return;
        this._lastSize = size;
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

  // True when any two rendered labels (or any two hour labels) overlap.
  _hasOverlap() {
    const overlapIn = (selector) => {
      const rects = [];
      this.shadowRoot.querySelectorAll(selector).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width) rects.push(r);
      });
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) return true;
        }
      }
      return false;
    };
    return overlapIn(".label") || overlapIn(".hour");
  }

  // `scale` shrinks every label font (temperature, icon, wind, unit, hour). The
  // first render uses 1; if labels overlap and shrink_to_fit is on, _render is
  // called again with smaller scales until nothing overlaps (see the end).
  _render(scale) {
    if (!this._config) return;
    const c = this._config;
    const k = scale || 1;
    const scaled = (o) => Object.assign({}, o, { size: Math.max(6, Math.round(o.size * k * 10) / 10) });
    const T = scaled(c.temperature);
    const HR = scaled(c.hour);
    const W = scaled(c.wind_speed);
    const WU = scaled(c.wind_unit);
    const CI = scaled(c.condition_icon);

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
    const r = c.dot_size;
    const labelGap = 4; // between a label and the dot below it
    const hourGap = 3; // between a dot and the hour label below it
    const hourH = Math.ceil(HR.size * 1.2) + 2;
    const mainH = Math.max(CI.size, T.size) + 2;
    const windH = c.show_wind ? Math.max(W.size, WU.size) + 2 : 0;
    const labelH = mainH + windH; // tallest possible label
    const padTop = c.padding_top == null ? labelH + labelGap + Math.max(r, c.line_width) + 2 : c.padding_top;
    // Room under the lowest point: its dot, then either its own hour label or the gap to the bottom row.
    const padBottom = Math.max(r, c.line_width) + hourGap + hourH;
    // The plot area is everything between padTop and padBottom. Its height is not
    // fixed: the card is chart_height tall at minimum and stretches to fill whatever
    // height its container gives it (a sections-view grid row, a stack sibling), so
    // vertical positions inside the plot are percentages.
    const minH = c.chart_height + (c.hours_next_to_line ? 0 : hourH);

    const temps = forecast.map((f) => Math.round(f.temperature));
    const min = n ? Math.min.apply(null, temps) : 0;
    const max = n ? Math.max.apply(null, temps) : 0;
    const span = max - min;
    const colW = n ? 100 / n : 100;
    const yOf = (t) => (span === 0 ? 50 : ((max - t) / span) * 100);
    const points = temps.map((t, i) => ({ x: colW * (i + 0.5), y: yOf(t) }));

    let svg = "";
    let separators = "";
    let labels = "";
    let hours = "";
    let dots = "";
    if (n) {
      if (c.show_separators) {
        for (let i = 1; i < n; i++) {
          if (forecast[i].condition !== forecast[i - 1].condition) {
            separators += '<div class="sep" style="left:' + (colW * i).toFixed(3) + '%;"></div>';
          }
        }
      }
      const poly = points.map((p) => p.x.toFixed(3) + "," + p.y.toFixed(3)).join(" ");
      svg =
        '<svg class="chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">' +
        '<polyline points="' + poly + '" fill="none" stroke="' + c.line_color + '" stroke-width="' + c.line_width +
        '" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>' +
        "</svg>";

      for (let i = 0; i < n; i++) {
        const f = forecast[i];
        const prev = i > 0 ? forecast[i - 1] : null;
        const wind = f.wind_speed != null ? Math.round(f.wind_speed) : null;
        const prevWind = prev && prev.wind_speed != null ? Math.round(prev.wind_speed) : null;
        const showCond = c.show_repeated_condition || !prev || f.condition !== prev.condition;
        const showTemp = c.show_repeated_temperature || !prev || temps[i] !== temps[i - 1];
        const showWind = c.show_wind && wind != null && (c.show_repeated_wind || !prev || wind !== prevWind);
        const at = "left:" + points[i].x.toFixed(3) + "%;top:" + points[i].y.toFixed(3) + "%;";

        let main = "";
        if (showCond) main += '<ha-icon class="icon" icon="' + this._iconFor(f) + '"></ha-icon>';
        if (showTemp) main += '<span class="temp">' + temps[i] + "\u00b0</span>";
        let inner = main ? '<div class="main">' + main + "</div>" : "";
        if (showWind) {
          inner += '<div class="wind">' + wind + '<span class="wind-unit">' + escapeHtml(unit) + "</span></div>";
        }
        if (r > 0) dots += '<div class="dot" style="' + at + '"></div>';
        if (inner) labels += '<div class="label" style="' + at + '">' + inner + "</div>";
        hours +=
          '<div class="hour" style="' + (c.hours_next_to_line ? at : "left:" + points[i].x.toFixed(3) + "%;bottom:0;") + '">' +
          this._formatHour(f.datetime) +
          "</div>";
      }
    }

    const style =
      "<style>" +
      ":host{display:block;height:100%;}" +
      "ha-card{background:" + c.background + ";border:none;box-shadow:none;border-radius:" + c.radius + "px;" +
      "padding:0 " + c.padding_x + "px " + c.padding_bottom + "px;box-sizing:border-box;height:100%;overflow:visible;}" +
      ".wrap{position:relative;width:100%;height:100%;min-height:" + minH + "px;}" +
      ".plot{position:absolute;left:0;right:0;top:" + padTop + "px;bottom:" + padBottom + "px;}" +
      ".chart{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;display:block;}" +
      ".sep{position:absolute;top:0;bottom:0;width:1px;background:" + c.separator_color + ";}" +
      ".dot{position:absolute;width:" + 2 * r + "px;height:" + 2 * r + "px;border-radius:50%;background:" + c.dot_color + ";" +
      "transform:translate(-50%,-50%);}" +
      ".label{position:absolute;display:flex;flex-direction:column;align-items:center;gap:2px;white-space:nowrap;" +
      "line-height:1;pointer-events:none;transform:translate(-50%,calc(-100% - " + (labelGap + r) + "px));}" +
      ".main{display:flex;align-items:center;gap:3px;}" +
      ".icon{--mdc-icon-size:" + CI.size + "px;width:" + CI.size + "px;height:" + CI.size + "px;color:" + CI.color + ";" +
      "background:" + CI.bg + ";border-radius:4px;display:flex;align-items:center;justify-content:center;}" +
      ".temp{font-size:" + T.size + "px;color:" + T.color + ";background:" + T.bg + ";border-radius:4px;padding:1px 2px;font-weight:600;}" +
      ".wind{font-size:" + W.size + "px;color:" + W.color + ";background:" + W.bg + ";border-radius:4px;padding:1px 2px;" +
      "display:flex;align-items:baseline;gap:1px;}" +
      ".wind-unit{font-size:" + WU.size + "px;color:" + WU.color + ";background:" + WU.bg + ";border-radius:3px;}" +
      ".hour{position:absolute;transform:translate(-50%," + (c.hours_next_to_line ? r + hourGap : 0) + "px);line-height:1.2;" +
      "white-space:nowrap;font-size:" + HR.size + "px;color:" + HR.color + ";background:" + HR.bg + ";border-radius:4px;padding:0 2px;}" +
      ".message{font-size:12px;color:var(--secondary-text-color);padding:8px 0;}" +
      "</style>";

    // Hours under their points live inside the plot (percent positions); the bottom
    // row lives in the wrap, below the plot.
    const hoursIn = c.hours_next_to_line ? hours : "";
    const hoursBelow = c.hours_next_to_line ? "" : hours;
    const body = message
      ? '<div class="message">' + escapeHtml(message) + "</div>"
      : '<div class="wrap">' + separators + '<div class="plot">' + svg + dots + labels + hoursIn + "</div>" + hoursBelow + "</div>";

    this.shadowRoot.innerHTML = style + "<ha-card>" + body + "</ha-card>";

    // Shrink pass: step the font scale down until nothing overlaps (or 50%).
    if (n && !scale && c.shrink_to_fit && this.isConnected && this._hasOverlap()) {
      for (let next = 0.9; next >= 0.5; next = Math.round((next - 0.1) * 10) / 10) {
        this._lastKey = null;
        this._render(next);
        if (next <= 0.5 || !this._hasOverlap()) break;
      }
    }
  }
}

if (!customElements.get(CARD_TAG)) customElements.define(CARD_TAG, MinimalWeatherLineChart);

/* ---------------------------------------------------------------------------
 * Visual editor
 * ------------------------------------------------------------------------- */

const LABELS = {
  entity: "Weather entity",
  hours: "Hours shown",
  until_midnight: "Only until midnight",
  show_wind: "Show wind speed",
  show_separators: "Separators between conditions",
  hours_next_to_line: "Hour under each point",
  shrink_to_fit: "Shrink text to fit",
  show_repeated_condition: "Repeat condition icon",
  show_repeated_temperature: "Repeat temperature",
  show_repeated_wind: "Repeat wind speed",
  chart_height: "Minimum chart height (px)",
  padding_top: "Padding above (px)",
  padding_bottom: "Padding below (px)",
  padding_x: "Padding left/right (px)",
  line_width: "Line width (px)",
  dot_size: "Dot radius (px)",
  line_color: "Line color",
  dot_color: "Dot color",
  separator_color: "Separator color",
  background: "Card background",
  radius: "Card corner radius (px)",
  size: "Font size (px)",
  color: "Text color",
  bg: "Background color",
  format: "Hour format",
  label: "Unit text",
};

const HELPERS = {
  entity: "Must support hourly forecasts.",
  hours: "Maximum number of hours. Default 12.",
  until_midnight: "Show only the hours before the next midnight (a 'rest of today' card). Still capped by Hours shown.",
  show_wind: "Wind speed on its own line under the temperature, in the entity's wind unit.",
  show_separators: "A thin vertical line wherever the condition changes, so each run of the same condition reads as a group.",
  hours_next_to_line: "On: each hour sits right under its data point. Off: all hours in one row along the bottom.",
  shrink_to_fit: "Shrink all label text until neighbouring labels no longer overlap. Off may cause labels to overlap.",
  show_repeated_condition: "Off hides the icon when the condition is the same as the previous hour.",
  show_repeated_temperature: "Off hides the temperature when it is the same as the previous hour.",
  show_repeated_wind: "Off hides the wind speed when it is the same as the previous hour.",
  chart_height: "The card grows to fill a taller container (e.g. a sections-view grid row). Default 84.",
  padding_top: "Space above the highest point. Leave empty for just enough room for the labels.",
  padding_bottom: "Card padding under the lowest content. Default 5.",
  padding_x: "Default 8.",
  line_width: "Default 2.",
  dot_size: "Leave empty for line width + 2. Set 0 to remove the dots.",
  line_color: "Any CSS color. Default rgba(255, 152, 0, 1).",
  dot_color: "Leave empty to match the line color.",
  separator_color: "Default var(--divider-color).",
  background: "Default transparent. Use var(--card-background-color) for a normal card.",
  radius: "Default 0.",
  size: "In px.",
  color: "Any CSS color, e.g. #ffcc80 or var(--primary-text-color).",
  bg: "Any CSS color. Default transparent.",
  format: "",
  label: "Leave empty to use the entity's wind unit.",
};

const styleSchema = (extra) =>
  [
    { name: "size", selector: { number: { min: 6, max: 64, mode: "box" } } },
    { name: "color", selector: { text: {} } },
    { name: "bg", selector: { text: {} } },
  ].concat(extra || []);

const EDITOR_SCHEMA = [
  { name: "entity", required: true, selector: { entity: { domain: "weather" } } },
  {
    type: "grid",
    schema: [
      { name: "hours", selector: { number: { min: 1, max: 48, mode: "box" } } },
      { name: "until_midnight", selector: { boolean: {} } },
      { name: "show_wind", selector: { boolean: {} } },
      { name: "show_separators", selector: { boolean: {} } },
      { name: "hours_next_to_line", selector: { boolean: {} } },
      { name: "shrink_to_fit", selector: { boolean: {} } },
    ],
  },
  {
    type: "expandable",
    title: "Repeated values",
    schema: [
      { name: "show_repeated_condition", selector: { boolean: {} } },
      { name: "show_repeated_temperature", selector: { boolean: {} } },
      { name: "show_repeated_wind", selector: { boolean: {} } },
    ],
  },
  {
    type: "expandable",
    title: "Size and spacing",
    schema: [
      {
        type: "grid",
        schema: [
          { name: "chart_height", selector: { number: { min: 20, max: 1000, mode: "box" } } },
          { name: "padding_top", selector: { number: { min: 0, max: 200, mode: "box" } } },
          { name: "padding_bottom", selector: { number: { min: 0, max: 200, mode: "box" } } },
          { name: "padding_x", selector: { number: { min: 0, max: 200, mode: "box" } } },
          { name: "line_width", selector: { number: { min: 0, max: 20, step: 0.5, mode: "box" } } },
          { name: "dot_size", selector: { number: { min: 0, max: 30, step: 0.5, mode: "box" } } },
        ],
      },
    ],
  },
  {
    type: "expandable",
    title: "Card and line colors",
    schema: [
      { name: "line_color", selector: { text: {} } },
      { name: "dot_color", selector: { text: {} } },
      { name: "separator_color", selector: { text: {} } },
      { name: "background", selector: { text: {} } },
      { name: "radius", selector: { number: { min: 0, max: 100, mode: "box" } } },
    ],
  },
  { type: "expandable", name: "temperature", title: "Temperature text", schema: styleSchema() },
  {
    type: "expandable",
    name: "hour",
    title: "Hour text",
    schema: styleSchema([
      {
        name: "format",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "12h", label: "12-hour (4pm)" },
              { value: "24h", label: "24-hour (16:00)" },
            ],
          },
        },
      },
    ]),
  },
  { type: "expandable", name: "wind_speed", title: "Wind speed text", schema: styleSchema() },
  { type: "expandable", name: "wind_unit", title: "Wind unit text", schema: styleSchema([{ name: "label", selector: { text: {} } }]) },
  { type: "expandable", name: "condition_icon", title: "Condition icon", schema: styleSchema() },
];

const isBlank = (v) => v == null || v === "";

// Form data = defaults with the config on top, so toggles show their real state.
const toFormData = (config) => {
  const data = Object.assign({}, DEFAULTS, config);
  Object.keys(STYLE_DEFAULTS).forEach((key) => {
    data[key] = Object.assign({}, STYLE_DEFAULTS[key], config[key] || {});
  });
  delete data.type;
  return data;
};

// Config = only what differs from the defaults, so the YAML stays minimal.
const toConfig = (data) => {
  const out = { entity: data.entity };
  Object.keys(data).forEach((key) => {
    const value = data[key];
    if (STYLE_DEFAULTS[key]) {
      const sub = {};
      Object.keys(value || {}).forEach((k) => {
        const v = value[k];
        const def = STYLE_DEFAULTS[key][k];
        if (isBlank(v) ? !isBlank(def) : v !== def) sub[k] = v;
      });
      if (Object.keys(sub).length) out[key] = sub;
      return;
    }
    const def = DEFAULTS[key];
    if (key === "entity" || (isBlank(value) ? !isBlank(def) : value !== def)) out[key] = value;
  });
  return out;
};

class MinimalWeatherLineChartEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._form = null;
  }

  setConfig(config) {
    this._config = config || {};
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  _update() {
    if (!this._config) return;
    if (!this._form) {
      this.shadowRoot.innerHTML = "<style>ha-form{display:block;}</style>";
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (schema) => LABELS[schema.name] || schema.name;
      this._form.computeHelper = (schema) => HELPERS[schema.name] || "";
      this._form.addEventListener("value-changed", (ev) => this._valueChanged(ev));
      this.shadowRoot.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = toFormData(this._config);
  }

  _valueChanged(ev) {
    ev.stopPropagation();
    const config = Object.assign({ type: this._config.type || "custom:" + CARD_TAG }, toConfig(ev.detail.value || {}));
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
  }
}

if (!customElements.get(EDITOR_TAG)) customElements.define(EDITOR_TAG, MinimalWeatherLineChartEditor);

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
