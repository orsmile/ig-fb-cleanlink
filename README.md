# IG/FB Clean Link

Tampermonkey 腳本：在 Instagram 與 Facebook 網頁版取得不帶追蹤碼的乾淨連結。

## 功能

- **複製連結**：IG 去除 `igsh`、`utm_source` 等參數；FB 的 `facebook.com/share/…` 短連結換成 permalink（例如 `/帳號/posts/pfbid…`、`/reel/<id>`）。
- **以 Messenger 傳送**：傳出去的是 permalink，端對端加密的聊天也一樣。
- **在來源就換掉**：打開分享視窗時，FB 向伺服器要 share 連結的回應裡本來就附有 permalink，腳本直接把它換過來，所以複製、Messenger、WhatsApp 等拿到的都是乾淨連結。換不到時才退回逐一攔截剪貼簿與 Messenger 封包。
- **網址列**：自動移除 `fbclid`、`igsh`、`__cft__` 等追蹤參數。
- **連結跳板**：`l.facebook.com/l.php?u=…` 還原成目標網址。
- **失敗時擋下**：轉換不成功（逾時、斷線、FB 改版）時，share 連結不會進剪貼簿，Messenger 訊息也不會送出，並跳出橘色提示說明原因。提示上有按鈕可以改用原本的 share 連結。
- **除錯紀錄**：每次轉換的結果與失敗原因都會記下來，方便回報問題。

## 安裝

1. 安裝 [Tampermonkey](https://www.tampermonkey.net/)（Chrome / Edge）。
2. 點這個連結：**[安裝 IG/FB Clean Link](https://raw.githubusercontent.com/orsmile/ig-fb-cleanlink/main/ig-fb-cleanlink.user.js)**，Tampermonkey 會跳出安裝頁，按「安裝」。
3. 重新整理 IG / FB 分頁。按 F12 在 Console 看到 `IG/FB Clean Link v… 已啟用` 即載入成功。

## 更新

Tampermonkey 會依腳本內的 `@updateURL` 定期檢查這個 repo，有新版就自動更新。要立刻更新，可在 Tampermonkey 管理面板對這個腳本按「檢查更新」，或再點一次上面的安裝連結。

如果你之前是用手動貼上的方式安裝，請先在管理面板刪掉舊的那份，再用安裝連結裝一次，之後才會自動更新。兩個版本同時啟用時腳本會提示。

## 設定

檔案開頭的 `CONFIG`。注意：自動更新會覆蓋你在 Tampermonkey 裡改過的設定，更新後需要重改一次。

| 選項 | 預設 | 說明 |
|---|---|---|
| `cleanAddressBar` | `true` | 清理網址列上的追蹤參數 |
| `cleanMessenger` | `true` | 以 Messenger 傳送時改寫連結 |
| `showToast` | `true` | 顯示一般提示（警示一律顯示） |
| `resolveTimeoutMs` | `8000` | 解析 share 連結的逾時 |
| `rewriteAtSource` | `true` | 打開分享視窗時就把 FB 給的 share 連結換成 permalink |
| `resolveRetries` | `1` | 解析失敗後再試幾次 |
| `messengerHoldMs` | `10000` | Messenger 訊息等待解析的上限 |
| `blockOnFailure` | `true` | 轉換失敗時擋下 share 連結；設為 `false` 則照原樣複製、傳送 |
| `debugLogSize` | `200` | 除錯紀錄保留筆數 |

## 轉換失敗時

橘色提示會寫出原因，並提供按鈕：

- **改複製原連結** / **仍用 share 連結送出**：這次不轉換，直接用原本的連結。
- **複製除錯紀錄**：把紀錄複製到剪貼簿，可以貼到 [issue](https://github.com/orsmile/ig-fb-cleanlink/issues)。

也可以按 F12，在 Console 執行 `__igFbCleanLinkLog()` 取得紀錄。紀錄存在瀏覽器的 localStorage（FB 與 IG 各一份），只保留最近 200 筆，不會傳到任何地方。內容包含你轉換過的連結，貼到公開場合前請先看過。

被擋下的 Messenger 訊息沒有送到對方，但 FB 的畫面上可能仍顯示成已送出，請以橘色提示為準。

## 限制

- 只對桌面版網頁有效，IG / FB 原生 App 無法介入。
- 解析 share 連結時，會以你的登入狀態向 FB 開啟一次該連結。
- 依賴 FB 未公開的內部格式（取得 share 連結的回應、Messenger 封包），FB 改版後可能失效。若 FB 改用完全不同的方式，腳本偵測不到，擋不下來也不會警示。
- 端對端加密聊天的訊息送出前就已加密，只能靠「在來源就換掉」處理。這一步失敗時會跳橘色提示，但擋不下那則訊息。
- 為了在來源換掉連結，腳本會包住頁面的 `JSON.parse`，只處理帶有 `wrapped_url` 的小型回應。
- 僅在 Chrome + Tampermonkey 上測試過。

## 測試

```
node --test tests/
```

## 授權

[MIT](LICENSE)

## 致謝

構想來自 [Jwander0820/threads-plugin](https://github.com/Jwander0820/threads-plugin)。
