# Minimal Weather Line Chart

A stripped-down hourly forecast card for Home Assistant: one temperature line, with the
temperature, condition icon and (optionally) wind speed sitting next to each point, and
compact hour labels underneath. Nothing else.

Forked from [mlamberts78/weather-chart-card](https://github.com/mlamberts78/weather-chart-card)
(which is no longer maintained). This repo replaces that card's forecast chart with a
purpose-built one. The upstream card and its documentation are still in the repo
(`src/main.js`, `docs/upstream-README.md`) for reference, but they are not what gets
installed.

## What changed from the original, and why

| Change | Reason |
| --- | --- |
| Temperatures are plain text, not Chart.js datalabels | On my dashboard the original card rendered each temperature as a white box with no visible number. The datalabels plugin paints a background from `--card-background-color` and text from `--primary-text-color`, and depending on the theme those resolve to the same (or an empty) color. Plain DOM text uses the theme's text color and cannot disappear. |
| `hide_repeats` option | If the temperature or condition is the same as the previous hour, repeating it is noise. Hiding repeats leaves only the hours where something changes. |
| Vertical separators between condition groups | With repeats hidden, an icon appears only when the condition changes. A subtle line at each change (e.g. cloudy, cloudy, cloudy, sunny, cloudy = 3 groups, 2 lines) makes it obvious how long each condition lasts. |
| Hours are `4pm`, never `4:00 PM` | Twelve columns are narrow. The short form fits and reads faster. |
| Much less vertical padding, and it's configurable | The original chart is 180px tall with generous padding. This one is 84px by default, with `chart_height`, `padding_top` and `padding_bottom` controls. |
| Condition icon and wind sit next to the temperature | The original stacked icons and wind in separate rows above and below the chart. Putting everything for an hour in one group makes each hour readable at a glance. |
| Wind is optional and off by default | Most of the time I only want the temperature line. |
| Per-element size, color and background for temperature, hour text, wind speed, wind unit and condition icon | So the card can be tuned to any dashboard theme. |
| `until_midnight` option | For a "rest of today" card. |
| `hours` option | Control how many hours are shown. |
| New card type: `custom:minimal-weather-line-chart` | A different element name so it can be installed alongside the original `weather-chart-card` without conflict. |
| Labels stagger upward when they would overlap | Twelve hours of icon + temperature + wind do not fit in a normal-width card on one row. A label that would collide with its left neighbour is lifted one row (the card grows to fit). Turn off with `stagger_labels: false`. |
| No Chart.js, no datalabels plugin, no canvas, no Lit | The whole card is one ~300-line file with no dependencies. |

## Installation

### HACS (custom repository)

1. HACS → Frontend → ⋮ → Custom repositories.
2. Add this repository's URL with category **Dashboard**.
3. Install **Minimal Weather Line Chart** and reload the browser.

### Manual

Copy `dist/minimal-weather-line-chart.js` to `config/www/` and add it as a dashboard
resource: Settings → Dashboards → ⋮ → Resources → `/local/minimal-weather-line-chart.js`
(type: JavaScript module).

## Usage

The weather entity must support hourly forecasts (the card subscribes to
`weather/subscribe_forecast` with `forecast_type: hourly`). If it does not, the card says so.

```yaml
type: custom:minimal-weather-line-chart
entity: weather.home
hide_repeats: true
```

Everything on:

```yaml
type: custom:minimal-weather-line-chart
entity: weather.home
hours: 12
until_midnight: false
hide_repeats: true
show_wind: true
chart_height: 84
padding_bottom: 4
line_color: "#4fc3f7"
temperature:
  size: 16
  color: "#ffcc80"
  bg: rgba(0, 0, 0, 0.5)
hour:
  size: 10
  color: var(--secondary-text-color)
  format: 12h
wind_speed:
  size: 10
  color: "#80deea"
wind_unit:
  size: 8
  label: mi/h
condition_icon:
  size: 22
  color: "#fff59d"
  bg: rgba(0, 0, 0, 0.5)
```

### Options

| Name | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | string | **required** | `custom:minimal-weather-line-chart` |
| `entity` | string | **required** | A `weather.*` entity with hourly forecast support. |
| `hours` | number | `12` | Maximum number of hours to show. |
| `until_midnight` | boolean | `false` | Only show hours before the next local midnight (still capped by `hours`). Late in the evening this can leave very few hours. |
| `hide_repeats` | boolean | `false` | Hide a temperature, condition icon or wind speed that is the same as the previous hour. |
| `show_separators` | boolean | same as `hide_repeats` | Draw a thin vertical line wherever the condition changes. |
| `separator_color` | string | `var(--divider-color)` | Color of the separators. |
| `show_wind` | boolean | `false` | Show wind speed next to the temperature, in the entity's `wind_speed_unit`. |
| `stagger_labels` | boolean | `true` | Lift a label one row when it would overlap its left neighbour. |
| `chart_height` | number | `84` | Height in px of the line area (the hour row is added below it). |
| `padding_top` | number | auto | Space in px above the highest point. Auto is just enough for the labels. |
| `padding_bottom` | number | `4` | Space in px between the lowest point and the hour row. |
| `padding_x` | number | `8` | Card side padding in px. |
| `line_color` | string | `rgba(255, 152, 0, 1)` | Line color. |
| `line_width` | number | `2` | Line width in px. |
| `background` | string | `transparent` | Card background. |
| `radius` | number | `0` | Card corner radius in px. |
| `temperature` | object | see below | Style for the temperature. |
| `hour` | object | see below | Style for the hour labels. Also takes `format: 12h` (default, `4pm`) or `24h` (`16:00`). |
| `wind_speed` | object | see below | Style for the wind speed number. |
| `wind_unit` | object | see below | Style for the wind unit. Also takes `label` to override the unit text. |
| `condition_icon` | object | see below | Style for the condition icon. |

Each style object accepts `size` (px), `color` and `bg` (any CSS color, including
`var(--primary-text-color)`). Defaults:

| Element | size | color | bg |
| --- | --- | --- | --- |
| `temperature` | 14 | `var(--primary-text-color)` | transparent |
| `hour` | 11 | `var(--secondary-text-color)` | transparent |
| `wind_speed` | 11 | `var(--primary-text-color)` | transparent |
| `wind_unit` | 9 | `var(--secondary-text-color)` | transparent |
| `condition_icon` | 18 | `var(--primary-text-color)` | transparent |

Condition icons are Material Design Icons via `ha-icon`. When a forecast entry has
`is_daytime: false`, `sunny` and `partlycloudy` use their night variants.

## Development

```
npm install
npm run build      # lint + rollup; writes dist/minimal-weather-line-chart.js
```

The card has no runtime dependencies, so `dist/minimal-weather-line-chart.js` is the
source file as-is.

## License

MIT, same as the upstream project. See `LICENSE.md`.
