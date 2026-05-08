// =====================================================================
// LMS Quick - background.js
// 役割:
//   1. content.js からのメッセージを受け取り設定画面を開く
//   2. CORSを回避するfetch代理
//   3. lms-wcタブのcontent.jsにfetchを依頼する（tabs.sendMessage経由）
// =====================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "openOptionsPage") {
        chrome.runtime.openOptionsPage();
    }

    // CORSを回避するためのfetch代理
    // lms-wcへのリクエストはservice workerのCookieストアを使う
    if (request.action === "fetchHtml") {
        fetch(request.url, { credentials: 'include' })
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return res.text();
            })
            .then(html => sendResponse({ ok: true, html }))
            .catch(err => sendResponse({ ok: false, error: err.message }));
        return true;
    }

    // lms-wcタブのcontent.jsにfetchを依頼する
    // scripting.executeScriptはWebClassのセッション競合を引き起こすため使わない
    // tabs.sendMessageはcontent.jsの隔離コンテキストで動くため安全
    if (request.action === "fetchInTab") {
        chrome.tabs.query({ url: "https://lms-wc.el.kanazawa-u.ac.jp/*" }, (tabs) => {
            if (tabs.length === 0) {
                sendResponse({ ok: false, error: 'NO_LMS_TAB' });
                return;
            }
            // コースページを含むどのlms-wcタブでもOK
            chrome.tabs.sendMessage(
                tabs[0].id,
                { action: 'fetchForScan', url: request.url },
                (response) => {
                    if (chrome.runtime.lastError) {
                        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
                    } else {
                        sendResponse(response);
                    }
                }
            );
        });
        return true;
    }
});