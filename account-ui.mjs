// OpenCode reads the English fallback; Magpie uses labels/messages for its locale.
export const ACCOUNT_ACTIONS = {
  cli: {
    label: "Use existing agy CLI login",
    labels: { zh: "使用已有 CLI 登录", "zh-TW": "使用既有 CLI 登入", ja: "既存の CLI ログインを使用", de: "Vorhandene CLI-Anmeldung verwenden" },
  },
  single: {
    label: "Import an account",
    labels: { zh: "导入账号", "zh-TW": "匯入帳號", ja: "アカウントをインポート", de: "Konto importieren" },
  },
  manifest: {
    label: "Import accounts from a manifest",
    labels: { zh: "批量导入账号", "zh-TW": "批次匯入帳號", ja: "アカウントを一括インポート", de: "Konten aus einer Liste importieren" },
  },
  google: {
    label: "Add a Google account",
    labels: { zh: "新增 Google 账号", "zh-TW": "新增 Google 帳號", ja: "Google アカウントを追加", de: "Google-Konto hinzufügen" },
  },
  saved: {
    label: "Use a saved Bridge account",
    labels: { zh: "使用已保存的 Bridge 账号", "zh-TW": "使用已儲存的 Bridge 帳號", ja: "保存済み Bridge アカウントを使用", de: "Gespeichertes Bridge-Konto verwenden" },
  },
}

export const ACCOUNT_NAME_PROMPT = {
  type: "text",
  key: "name",
  message: "Account name (an existing name signs that account in again: only its credential is replaced, its conversations stay)",
  messages: {
    zh: "账号名称（填写已有名称即重新登录该账号：只替换登录凭据，对话记录保留）",
    "zh-TW": "帳號名稱（填寫既有名稱即重新登入該帳號：只替換登入憑證，對話紀錄保留）",
    ja: "アカウント名（既存の名前を指定するとそのアカウントに再ログインします。認証情報のみ置き換え、会話は保持されます）",
    de: "Kontoname (ein vorhandener Name meldet dieses Konto erneut an: nur die Anmeldedaten werden ersetzt, Unterhaltungen bleiben erhalten)",
  },
  placeholder: "work",
}
