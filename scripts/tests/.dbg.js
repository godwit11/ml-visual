const out = []
const nn = window.__nn
const g = nn.grid(9)
out.push('grid.x=' + JSON.stringify(g.x.map(v => +v.toFixed(3))))
out.push('grid.y=' + JSON.stringify(g.y.map(v => +v.toFixed(3))))
out.push('values 9x9 row0=' + JSON.stringify(g.values[0].map(v => +v.toFixed(4))))
const chart = q('#chart-space').__chart.chart
const opt = chart.getOption()
out.push('series types=' + JSON.stringify(opt.series.map(s => s.type + ':' + s.name)))
out.push('custom data len=' + (opt.series[0].data || []).length)
out.push('data[0]=' + JSON.stringify(opt.series[0].data?.[0]))
out.push('data[1]=' + JSON.stringify(opt.series[0].data?.[1]))
out.push('data[72]=' + JSON.stringify(opt.series[0].data?.[72]))
out.push('xAxis min/max=' + opt.xAxis[0].min + '/' + opt.xAxis[0].max)
out.push('yAxis min/max=' + opt.yAxis[0].min + '/' + opt.yAxis[0].max)
return { ok: true, out }
