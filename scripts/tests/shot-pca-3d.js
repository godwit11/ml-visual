/* PCA 页截图：三维点云，3 维降 2 维保住 99%。 */
setSelect('#sel-data', 'cloud3d')
await sleep(900)

return { ok: true, dataset: q("#sel-data").value, k: window.__pca.k, cur: window.__pca.curVar, best: window.__pca.bestVar }

return { ok: true, dataset: q("#sel-data").value, k: window.__pca.k, cur: window.__pca.curVar, best: window.__pca.bestVar }
