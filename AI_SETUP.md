# AI写真解析の設定

食事写真の解析は、APIキーをブラウザへ公開しないよう Supabase Edge Function から Gemini API を呼び出します。

## 必要な設定

1. `config.js` に Supabase の URL と anon key を設定します。
2. Supabase CLI でログインし、このプロジェクトをリンクします。
3. Gemini APIキーをSupabaseの秘密情報として登録します。
4. `analyze-meal` Edge Functionをデプロイします。

```sh
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set GEMINI_API_KEY=YOUR_GEMINI_API_KEY
supabase functions deploy analyze-meal --no-verify-jwt
```

モデルを変更する場合は、任意で次も設定できます。未設定時は `gemini-2.5-flash` を使います。

```sh
supabase secrets set GEMINI_VISION_MODEL=gemini-2.5-flash
```

## 使用方法

1. アプリの「設定」でログインします。
2. 「食事追加」で食事写真、栄養成分表示の写真、または食材と分量を入力します。
3. 「AIで計算・写真解析」を押します。
4. 自動入力された料理名、カロリー、PFCを確認・修正して保存します。

精度を上げるには、食材の重量、皮の有無、調理状態、食べた個数を補足欄へ入力してください。
市販品は栄養成分表示を明るく正面から撮影すると、記載値を優先して計算できます。
