const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const nutritionSchema = {
  type: "object",
  required: ["name", "calories", "protein", "fat", "carbs", "confidence", "items", "assumptions"],
  properties: {
    name: { type: "string", description: "写真に写っている食事全体の短い日本語名" },
    calories: { type: "number", description: "食事全体の推定カロリー kcal" },
    protein: { type: "number", description: "食事全体の推定タンパク質 g" },
    fat: { type: "number", description: "食事全体の推定脂質 g" },
    carbs: { type: "number", description: "食事全体の推定炭水化物 g" },
    confidence: { type: "number", description: "推定の確信度。0から1" },
    items: {
      type: "array",
      items: { type: "string" },
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
    },
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function splitDataUrl(image: string) {
  const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  return match ? { mimeType: match[1], data: match[2] } : null;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseStructuredResult(text: string) {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Gemini returned no JSON object");

  const json = cleaned
    .slice(start, end + 1)
    .replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(json);
}

async function analyzeWithGemini(
  apiKey: string,
  model: string,
  imageData: { mimeType: string; data: string } | null,
  labelImageData: Array<{ mimeType: string; data: string }>,
  mealHint: string,
  details: string
) {
  const requestParts: Array<Record<string, unknown>> = [
    {
      text: [
        imageData
          ? "この食事写真、栄養成分表示、ユーザーの補足情報を日本の栄養記録用に分析してください。"
          : labelImageData.length
            ? "栄養成分表示の写真とユーザーの補足情報から、食事全体の栄養を計算してください。"
            : "ユーザーが入力した食材と分量を、日本の栄養記録用に計算してください。",
        labelImageData.length
          ? "「栄養成分表示」として添付された画像の文字と数値を正確に読み取ってください。"
          : "",
        "パッケージ記載のエネルギー、たんぱく質、脂質、炭水化物は、一般的な推定値より必ず優先してください。",
        "表示が「1包装当たり」「1個当たり」なら食べた包装数・個数を掛け、「100g当たり」なら食べた重量に換算してください。",
        "複数の商品ラベルがある場合は、商品ごとに換算してから全商品のカロリーとPFCを合計してください。",
        "栄養表示の単位、基準量、数値が読めない場合は推測で補わず assumptions に記載してください。",
        "ユーザーが明記した重量、皮の有無、生・加熱後などの調理状態を最優先してください。",
        "重量が明記された食材は写真から量を推測せず、入力値を使ってください。",
        "見える料理または入力食材を構成要素ごとに特定し、一般的な日本食品成分値を基準に計算してください。",
        "調理油、ソース、ドレッシング、衣など、明記または写真で確認できるカロリーも合理的に含めてください。",
        "calories は kcal、protein/fat/carbs は g で、食事全体の合計を返してください。",
        "画像や入力から判断できない点は assumptions に明記し、過度な確信を避けてください。",
        mealHint ? `ユーザーが入力した料理名: ${mealHint}` : "",
        details ? `ユーザーが入力した食材・分量・調理状態: ${details}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
  if (imageData) {
    requestParts.push({
      inline_data: {
        mime_type: imageData.mimeType,
        data: imageData.data,
      },
    });
  }
  labelImageData.forEach((labelImage, index) => {
    requestParts.push({ text: `栄養成分表示の画像 ${index + 1}` });
    requestParts.push({
      inline_data: {
        mime_type: labelImage.mimeType,
        data: labelImage.data,
      },
    });
  });

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: requestParts,
          },
        ],
        tools: [
          {
            functionDeclarations: [
              {
                name: "record_meal_analysis",
                description: "食事写真から推定した料理名、カロリー、PFC、内訳と仮定を記録する",
                parameters: nutritionSchema,
              },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: {
            mode: "ANY",
            allowedFunctionNames: ["record_meal_analysis"],
          },
        },
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1200,
        },
      }),
    }
  );

  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body?.error?.message || `Gemini API error ${response.status}`);
    Object.assign(error, { status: response.status });
    throw error;
  }

  const responseParts = body?.candidates?.[0]?.content?.parts || [];
  const functionCall = responseParts.find(
    (part: { functionCall?: { name?: string; args?: unknown } }) =>
      part.functionCall?.name === "record_meal_analysis"
  )?.functionCall;
  if (functionCall?.args && typeof functionCall.args === "object") {
    return functionCall.args;
  }

  const text = responseParts.find(
    (part: { text?: string }) => typeof part.text === "string"
  )?.text;
  if (!text) throw new Error("Gemini returned no structured result");
  return parseStructuredResult(text);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authorization = request.headers.get("Authorization");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!authorization || !supabaseUrl || !supabaseAnonKey) {
    return jsonResponse({ error: "Authentication is required" }, 401);
  }

  let isAuthenticated = false;
  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: authorization,
        apikey: supabaseAnonKey,
      },
    });
    isAuthenticated = userResponse.ok;
  } catch (error) {
    console.error("Supabase authentication check failed", error);
  }
  if (!isAuthenticated) {
    return jsonResponse({ error: "Authentication is required" }, 401);
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return jsonResponse({ error: "GEMINI_API_KEY is not configured" }, 500);
  }

  try {
    const { image, labelImages, hint, details } = await request.json();
    const imageData = typeof image === "string" ? splitDataUrl(image) : null;
    const labelImageData = Array.isArray(labelImages)
      ? labelImages
          .slice(0, 4)
          .map((labelImage) => (typeof labelImage === "string" ? splitDataUrl(labelImage) : null))
          .filter((labelImage): labelImage is { mimeType: string; data: string } => Boolean(labelImage))
      : [];
    const mealHint = typeof hint === "string" ? hint.trim().slice(0, 200) : "";
    const mealDetails = typeof details === "string" ? details.trim().slice(0, 1000) : "";
    if (!imageData && !labelImageData.length && !mealDetails) {
      return jsonResponse({ error: "A meal photo, nutrition label, or ingredient details are required" }, 400);
    }

    const preferredModel = Deno.env.get("GEMINI_VISION_MODEL") || "gemini-2.5-flash";
    const models = [...new Set([preferredModel, "gemini-2.5-flash-lite"])];
    let lastError: Error | null = null;

    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return jsonResponse(
            await analyzeWithGemini(apiKey, model, imageData, labelImageData, mealHint, mealDetails)
          );
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const status = Number((error as { status?: number })?.status || 0);
          console.error("Gemini analysis attempt failed", { model, attempt: attempt + 1, status, error });
          if (![429, 500, 502, 503, 504].includes(status) && !lastError.message.includes("JSON")) break;
          if (attempt < 1) await wait(1200);
        }
      }
    }

    return jsonResponse(
      { error: lastError?.message || "Gemini analysis failed after retries" },
      502
    );
  } catch (error) {
    console.error("Meal analysis failed", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Meal analysis failed" },
      500
    );
  }
});
