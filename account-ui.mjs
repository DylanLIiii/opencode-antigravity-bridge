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
  message: "New account name (existing accounts are kept; use a new name)",
  messages: {
    zh: "新账号名称（已有账号会保留，请使用未占用的名称）",
    "zh-TW": "新帳號名稱（既有帳號會保留，請使用尚未使用的名稱）",
    ja: "新しいアカウント名（既存のアカウントは保持されます。未使用の名前を指定してください）",
    de: "Neuer Kontoname (vorhandene Konten bleiben erhalten; neuen Namen verwenden)",
  },
  placeholder: "work",
}
