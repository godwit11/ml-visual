const out = []
const chart = q('#chart-space').__chart.chart
const opt = chart.getOption()
out.push('custom series keys=' + JSON.stringify(Object.keys(opt.series[0])))
out.push('encode=' + JSON.stringify(opt.series[0].encode))
out.push('dimensions=' + JSON.stringify(opt.series[0].dimensions))
out.push('coordinateSystem=' + opt.series[0].coordinateSystem)
return { ok: true, out }
