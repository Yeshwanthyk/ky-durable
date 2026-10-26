import { type PointerEvent, useState } from "react";
import type { ShownBlock } from "../cards/contract";

/**
 * A ui card's chart block, drawn from its numbers: bars, a line, or a donut.
 * Series take the theme's --chart-N colors, so a chart reads the same in both
 * themes and beside a stats block that names the same series.
 */

type Chart = Extract<ShownBlock, { type: "chart" }>;

type Series = Chart["series"][number];

export const seriesColor = (index: number) => `var(--chart-${(index % 6) + 1})`;

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

const format = (value: number, unit: string | undefined) => `${number.format(value)}${unit ?? ""}`;

/** A series' value at x, 0 where the series ran short. */
const at = (series: Series, index: number) => series.values[index] ?? 0;

export function ChartBlock({ chart }: { chart: Chart }) {
  return (
    <figure className="ui-chart" data-kind={chart.kind}>
      {chart.label ? <figcaption className="ui-block-label">{chart.label}</figcaption> : null}
      {chart.kind === "bar" ? <Bars chart={chart} /> : chart.kind === "line" ? <Line chart={chart} /> : <Donut chart={chart} />}
      {chart.kind !== "donut" && chart.series.length > 1 ? <Legend names={chart.series.map((series) => series.name)} /> : null}
    </figure>
  );
}

function Legend({ names }: { names: readonly string[] }) {
  return (
    <ul className="ui-legend">
      {names.map((name, index) => (
        <li key={index}>
          <i style={{ background: seriesColor(index) }} />
          {name}
        </li>
      ))}
    </ul>
  );
}

/** A row per x: the series side by side, or stacked in one bar with their total at its end. */
function Bars({ chart }: { chart: Chart }) {
  const stacked = chart.stacked === true && chart.series.length > 1;
  const totals = chart.x.map((_, index) => chart.series.reduce((sum, series) => sum + Math.max(0, at(series, index)), 0));
  const max = Math.max(1e-9, ...(stacked ? totals : chart.series.flatMap((series) => series.values)));
  const width = (value: number) => `${(Math.max(0, value) / max) * 100}%`;

  return (
    <div className="ui-bars" role="table" aria-label={chart.label ?? "Chart"}>
      {chart.x.map((label, index) => (
        <div className="ui-bar-row" role="row" key={index}>
          <span className="ui-bar-x" role="rowheader">
            {label}
          </span>
          {stacked ? (
            <span className="ui-bar-track" role="cell" title={chart.series.map((series) => `${series.name} ${format(at(series, index), chart.unit)}`).join(" · ")}>
              <span className="ui-bar-fill">
                {chart.series.map((series, which) => (
                  <i key={which} style={{ width: width(at(series, index)), background: seriesColor(which) }} />
                ))}
              </span>
              <b>{format(totals[index] ?? 0, chart.unit)}</b>
            </span>
          ) : (
            <span className="ui-bar-group" role="cell">
              {chart.series.map((series, which) => (
                <span className="ui-bar-track" key={which} title={`${series.name} ${format(at(series, index), chart.unit)}`}>
                  <span className="ui-bar-fill">
                    <i style={{ width: width(at(series, index)), background: seriesColor(which) }} />
                  </span>
                  <b>{format(at(series, index), chart.unit)}</b>
                </span>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

const LINE_HEIGHT = 140;

/** A trend: one line per series over a fixed height, the x under it; a pointer over it reads each series at that x. */
function Line({ chart }: { chart: Chart }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = chart.series.flatMap((series) => series.values);
  const top = Math.max(...values, 0);
  const bottom = Math.min(...values, 0);
  const span = top - bottom || 1;
  const last = Math.max(1, chart.x.length - 1);
  const xAt = (index: number) => (index / last) * 100;
  const yAt = (value: number) => 100 - ((value - bottom) / span) * 100;

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setHover(Math.round(((event.clientX - box.left) / Math.max(1, box.width)) * last));
  };

  return (
    <div className="ui-line">
      <span className="ui-line-top quiet">{format(top, chart.unit)}</span>
      <div className="ui-line-plot" style={{ height: LINE_HEIGHT }} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={chart.label ?? "Line chart"}>
          {chart.series.map((series, which) => (
            <polyline
              key={which}
              fill="none"
              stroke={seriesColor(which)}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              points={chart.x.map((_, index) => `${xAt(index)},${yAt(at(series, index))}`).join(" ")}
            />
          ))}
        </svg>
        {hover === null ? null : <LineHover chart={chart} index={hover} left={xAt(hover)} />}
      </div>
      <div className="ui-line-x quiet">
        <span>{chart.x[0]}</span>
        {chart.x.length > 2 ? <span>{chart.x[Math.floor(last / 2)]}</span> : null}
        {chart.x.length > 1 ? <span>{chart.x[last]}</span> : null}
      </div>
    </div>
  );
}

function LineHover({ chart, index, left }: { chart: Chart; index: number; left: number }) {
  return (
    <>
      <span className="ui-line-rule" style={{ left: `${left}%` }} />
      <span className="ui-line-tip" style={{ left: `${left}%` }} data-side={left > 60 ? "left" : "right"}>
        <b>{chart.x[index]}</b>
        {chart.series.map((series, which) => (
          <span key={which}>
            <i style={{ background: seriesColor(which) }} />
            {chart.series.length > 1 ? `${series.name} ` : ""}
            {format(at(series, index), chart.unit)}
          </span>
        ))}
      </span>
    </>
  );
}

/** Shares of the first series, a slice per x, its legend beside it with each value and share. */
function Donut({ chart }: { chart: Chart }) {
  const [series] = chart.series;
  const values = chart.x.map((_, index) => (series ? Math.max(0, at(series, index)) : 0));
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  const starts = values.map((_, index) => values.slice(0, index).reduce((sum, value) => sum + value, 0));

  return (
    <div className="ui-donut">
      <svg viewBox="0 0 42 42" role="img" aria-label={chart.label ?? series?.name ?? "Donut chart"}>
        <circle cx="21" cy="21" r="15.915" fill="none" stroke="var(--raised)" strokeWidth="6" />
        {values.map((value, index) => (
          <circle
            key={index}
            cx="21"
            cy="21"
            r="15.915"
            fill="none"
            stroke={seriesColor(index)}
            strokeWidth="6"
            strokeDasharray={`${(value / total) * 100} ${100 - (value / total) * 100}`}
            strokeDashoffset={25 - ((starts[index] ?? 0) / total) * 100}
          />
        ))}
      </svg>
      <ul className="ui-legend" data-stacked="true">
        {chart.x.map((label, index) => (
          <li key={index}>
            <i style={{ background: seriesColor(index) }} />
            <span>{label}</span>
            <b>{format(values[index] ?? 0, chart.unit)}</b>
            <span className="quiet">{Math.round(((values[index] ?? 0) / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
