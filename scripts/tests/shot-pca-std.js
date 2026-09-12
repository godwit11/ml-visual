/* PCA 页截图：切到「鸢尾花（标准化后）」，展示主成分被换掉。 */
setSelect('#sel-data', 'iris-std')
await sleep(900)

return { ok: true, dataset: q("#sel-data").value, k: window.__pca.k, cur: window.__pca.curVar, best: window.__pca.bestVar }

return { ok: true, dataset: q("#sel-data").value, k: window.__pca.k, cur: window.__pca.curVar, best: window.__pca.bestVar }
