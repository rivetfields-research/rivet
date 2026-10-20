import { init, use } from 'echarts/core';
import { BarChart, LineChart, ScatterChart } from 'echarts/charts';
import { AriaComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { TabularChartOption } from './tabular-chart';

// Load with the workspace: an open tab must not fetch a retired release's chunk
// when its first saved chart is opened. No canvas renderer or arbitrary templates.
use([BarChart, LineChart, ScatterChart, GridComponent, LegendComponent, AriaComponent, TitleComponent, TooltipComponent, SVGRenderer]);
export { init };

/** ECharts writes escaped SVG text from our fixed chart options; no source HTML or remote images. */
export function renderChartImage(option: TabularChartOption, title: string, context: string): string {
  const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 1200, height: 720 });
  const legend = Array.isArray(option.legend) ? option.legend[0] : option.legend;
  try {
    chart.setOption({ ...option,
      tooltip: { show: false },
      title: { text: title, subtext: context, left: 24, top: 20, textStyle: { fontSize: 20, color: '#2a2a2a' }, subtextStyle: { fontSize: 13, color: '#555555', lineHeight: 20 } },
      grid: { left: 24, right: 24, top: legend ? 156 : 128, bottom: 24, outerBoundsMode: 'same', outerBoundsContain: 'all' },
      ...(legend ? { legend: { ...legend, top: 118 } } : {}),
    });
    return chart.renderToSVGString({ useViewBox: true });
  } finally { chart.dispose(); }
}
