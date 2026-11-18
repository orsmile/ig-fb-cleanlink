# IG/FB Clean Link

Tampermonkey 腳本：在 Instagram 與 Facebook 網頁版取得不帶追蹤碼的乾淨連結。

## 功能

- **複製連結**：IG 去除 `igsh`、`utm_source` 等參數；FB 的 `facebook.com/share/…` 短連結換成 permalink（例如 `/帳號/posts/pfbid…`、`/reel/<id>`）。
- **以 Messenger 傳送**：送出前把訊息裡的 share 連結換成 permalink。
- **網址列**：自動移除 `fbclid`、`igsh`、`__cft__` 等追蹤參數。
- **連結跳板**：`l.facebook.com/l.php?u=…` 還原成目標網址。
- **改版警示**：偵測到 FB 的格式改變、無法安全處理時，跳出橘色提示並照原樣處理，不會擋下複製或訊息。

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
| `messengerHoldMs` | `4000` | Messenger 訊息等待解析的上限，超過就照原樣送出 |

## 限制

- 只對桌面版網頁有效，IG / FB 原生 App 無法介入。
- 解析 share 連結時，會以你的登入狀態向 FB 開啟一次該連結。
- Messenger 改寫依賴 FB 未公開的內部封包格式，FB 改版後可能失效。若 FB 改用完全不同的傳送方式，腳本偵測不到，也不會警示。
- 僅在 Chrome + Tampermonkey 上測試過。

## 測試

```
node --test tests/
```

## 授權

[MIT](LICENSE)

## 致謝

構想來自 [Jwander0820/threads-plugin](https://github.com/Jwander0820/threads-plugin)。
