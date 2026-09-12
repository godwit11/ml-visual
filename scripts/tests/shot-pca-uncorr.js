/* PCA 页截图：相关 vs 不相关对比 —— 用「不相关二维数据」展示"没有冗余就压不动"。 */
setSelect('#sel-data', 'uncorr')
await sleep(900)

return { ok: true, dataset: q("#sel-data").value, k: window.__pca.k, cur: window.__pca.curVar, best: window.__pca.bestVar }

return { ok: true, dataset: q("#sel-data").value, k: window.__pca.k, cur: window.__pca.curVar, best: window.__pca.bestVar }
