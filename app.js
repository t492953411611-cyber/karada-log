const storeKey = "nourish-track-prototype";

const defaultState = {
  settings: {
    sex: "male",
    age: 35,
    height: 170,
    bodyWeight: 70,
    activity: 1.375,
    goal: "maintain",
    calorieOffset: 0,
    manualTdee: "",
  },
  meals: [],
  weights: [],
};

let state = loadState();
let selectedPhoto = "";
let nutritionLabelPhotos = [];
let cloudClient = null;
let cloudUser = null;
let cloudReady = false;

const $ = (id) => document.getElementById(id);
const today = () => new Date().toISOString().slice(0, 10);
const number = (value) => Number(value) || 0;
const rounded = (value) => Math.round(value);
const formatDecimal = (value) =>
  number(value).toLocaleString("ja-JP", {
    maximumFractionDigits: 2,
  });
const formatGrams = formatDecimal;

function loadState() {
  try {
    const raw = localStorage.getItem(storeKey);
    return raw ? { ...defaultState, ...JSON.parse(raw) } : structuredClone(defaultState);
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState() {
  try {
    localStorage.setItem(storeKey, JSON.stringify(state));
    return true;
  } catch (error) {
    console.error("Failed to save app state", error);
    return false;
  }
}

function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setStatus(id, message, tone = "success") {
  const element = $(id);
  if (!element) return;
  element.textContent = message;
  element.dataset.tone = tone;
}

function resizeImage(dataUrl, maxSide = 760, quality = 0.68) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    image.onerror = () => resolve(dataUrl);
    image.src = dataUrl;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function isLikelyImage(file) {
  const imageExtensions = /\.(avif|gif|heic|heif|jpeg|jpg|png|webp)$/i;
  return file.type.startsWith("image/") || imageExtensions.test(file.name);
}

function initCloudClient() {
  const config = window.SUPABASE_CONFIG || {};
  if (!config.url || !config.anonKey || !window.supabase) {
    cloudReady = false;
    setCloudStatus("クラウド未設定です。現在はこの端末だけに保存されます。");
    return;
  }

  cloudClient = window.supabase.createClient(config.url, config.anonKey);
  cloudReady = true;
  setCloudStatus("クラウドに接続できます。ログインすると保存先がクラウドになります。");
}

function setCloudStatus(message) {
  if ($("cloudStatus")) $("cloudStatus").textContent = message;
}

function updateAuthUi() {
  if (!cloudReady) {
    $("sendLoginLink").disabled = true;
    $("signOutButton").classList.remove("is-visible");
    return;
  }

  $("sendLoginLink").disabled = Boolean(cloudUser);
  $("signOutButton").classList.toggle("is-visible", Boolean(cloudUser));
  setCloudStatus(
    cloudUser
      ? `${cloudUser.email || "ログイン中のユーザー"} としてクラウド保存中です。`
      : "ログインすると、食事・写真・体重がクラウドに保存されます。"
  );
}

async function setupCloudAuth() {
  initCloudClient();
  updateAuthUi();
  if (!cloudReady) return;

  const { data } = await cloudClient.auth.getSession();
  cloudUser = data.session?.user || null;
  updateAuthUi();
  if (cloudUser) await loadCloudState();

  cloudClient.auth.onAuthStateChange(async (_event, session) => {
    cloudUser = session?.user || null;
    updateAuthUi();
    if (cloudUser) await loadCloudState();
  });
}

async function loadCloudState() {
  if (!cloudReady || !cloudUser) return;

  setCloudStatus("クラウドからデータを読み込んでいます。");

  const [{ data: profile }, { data: meals }, { data: weights }] = await Promise.all([
    cloudClient.from("profiles").select("settings").eq("user_id", cloudUser.id).maybeSingle(),
    cloudClient.from("meals").select("*").order("created_at", { ascending: true }),
    cloudClient.from("weights").select("*").order("date", { ascending: true }),
  ]);

  const cloudMeals = await Promise.all(
    (meals || []).map(async (meal) => ({
      id: meal.id,
      createdAt: meal.created_at,
      date: meal.date,
      type: meal.type,
      name: meal.name,
      calories: number(meal.calories),
      protein: number(meal.protein),
      fat: number(meal.fat),
      carbs: number(meal.carbs),
      note: meal.note || "",
      photoPath: meal.photo_path || "",
      photo: meal.photo_path ? await signedMealPhotoUrl(meal.photo_path) : "",
    }))
  );

  state = {
    settings: { ...defaultState.settings, ...(profile?.settings || {}) },
    meals: cloudMeals,
    weights: (weights || []).map((item) => ({ date: item.date, value: number(item.value) })),
  };
  saveState();
  fillSettingsForm();
  renderAll();
  setCloudStatus(`${cloudUser.email || "ログイン中のユーザー"} としてクラウド保存中です。`);
}

async function signedMealPhotoUrl(path) {
  const { data, error } = await cloudClient.storage.from("meal-photos").createSignedUrl(path, 60 * 60 * 24);
  return error ? "" : data.signedUrl;
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function uploadMealPhoto(meal) {
  if (!meal.photo || !meal.photo.startsWith("data:")) return meal.photoPath || "";
  const blob = await dataUrlToBlob(meal.photo);
  const path = `${cloudUser.id}/${meal.id}.jpg`;
  const { error } = await cloudClient.storage.from("meal-photos").upload(path, blob, {
    contentType: "image/jpeg",
    upsert: true,
  });
  if (error) throw error;
  return path;
}

async function saveSettingsToCloud() {
  if (!cloudReady || !cloudUser) return true;
  const { error } = await cloudClient.from("profiles").upsert({
    user_id: cloudUser.id,
    settings: state.settings,
    updated_at: new Date().toISOString(),
  });
  return !error;
}

async function saveMealToCloud(meal) {
  if (!cloudReady || !cloudUser) return true;
  const photoPath = await uploadMealPhoto(meal);
  const { error } = await cloudClient.from("meals").upsert({
    id: meal.id,
    user_id: cloudUser.id,
    date: meal.date,
    type: meal.type,
    name: meal.name,
    calories: meal.calories,
    protein: meal.protein,
    fat: meal.fat,
    carbs: meal.carbs,
    note: meal.note,
    photo_path: photoPath,
    created_at: meal.createdAt,
  });
  if (error) throw error;
  meal.photoPath = photoPath;
  if (photoPath) meal.photo = await signedMealPhotoUrl(photoPath);
  return true;
}

async function deleteMealFromCloud(meal) {
  if (!cloudReady || !cloudUser) return true;
  if (meal.photoPath) await cloudClient.storage.from("meal-photos").remove([meal.photoPath]);
  const { error } = await cloudClient.from("meals").delete().eq("id", meal.id);
  return !error;
}

async function saveWeightToCloud(date, value, oldDate = "") {
  if (!cloudReady || !cloudUser) return true;
  if (oldDate && oldDate !== date) {
    await cloudClient.from("weights").delete().eq("date", oldDate);
  }
  const { error } = await cloudClient.from("weights").upsert({
    user_id: cloudUser.id,
    date,
    value,
    updated_at: new Date().toISOString(),
  });
  return !error;
}

async function deleteWeightFromCloud(date) {
  if (!cloudReady || !cloudUser) return true;
  const { error } = await cloudClient.from("weights").delete().eq("date", date);
  return !error;
}

function bmr(settings = state.settings) {
  const sexOffset = settings.sex === "male" ? 5 : -161;
  return 10 * number(settings.bodyWeight) + 6.25 * number(settings.height) - 5 * number(settings.age) + sexOffset;
}

function tdee() {
  if (number(state.settings.manualTdee) > 0) return number(state.settings.manualTdee);
  return bmr() * number(state.settings.activity);
}

function goalTarget() {
  const base = tdee();
  const offset = number(state.settings.calorieOffset);
  if (state.settings.goal === "cut") return base - Math.abs(offset || 400);
  if (state.settings.goal === "bulk") return base + Math.abs(offset || 300);
  return base + offset;
}

function goalName() {
  if (state.settings.goal === "cut") return "減量モード";
  if (state.settings.goal === "bulk") return "増量モード";
  return "維持モード";
}

function targetMacros() {
  const calories = Math.max(0, goalTarget());
  const weight = number(state.settings.bodyWeight) || 70;
  const proteinRatio = state.settings.goal === "cut" ? 2 : state.settings.goal === "bulk" ? 1.8 : 1.6;
  const protein = Math.round(weight * proteinRatio);
  const fat = Math.round((calories * 0.25) / 9);
  const carbs = Math.max(0, Math.round((calories - protein * 4 - fat * 9) / 4));
  return { calories: rounded(calories), protein, fat, carbs };
}

function mealsForDate(date) {
  return state.meals.filter((meal) => meal.date === date);
}

function totalsForDate(date) {
  return mealsForDate(date).reduce(
    (sum, meal) => ({
      calories: sum.calories + number(meal.calories),
      protein: sum.protein + number(meal.protein),
      fat: sum.fat + number(meal.fat),
      carbs: sum.carbs + number(meal.carbs),
    }),
    { calories: 0, protein: 0, fat: 0, carbs: 0 }
  );
}

function setView(viewId) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("is-active", view.id === viewId));
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === viewId));
}

function renderDashboard() {
  const date = $("todayDate").value || today();
  const totals = totalsForDate(date);
  const base = rounded(tdee());
  const target = rounded(goalTarget());
  const macros = targetMacros();
  const diff = rounded(totals.calories - target);
  const maxMeter = Math.max(target * 1.5, 1);
  const fillPercent = Math.min(100, (totals.calories / maxMeter) * 100);
  const targetPercent = Math.min(100, (target / maxMeter) * 100);

  $("goalLabel").textContent = goalName();
  $("targetCaloriesLabel").textContent = `TDEE ${base} kcal / 目標 ${target} kcal`;
  $("todayCalories").textContent = formatDecimal(totals.calories);
  $("todayProtein").textContent = formatGrams(totals.protein);
  $("todayFat").textContent = formatGrams(totals.fat);
  $("todayCarbs").textContent = formatGrams(totals.carbs);
  $("targetCaloriesSmall").textContent = `目標 ${macros.calories} kcal`;
  $("targetProteinSmall").textContent = `目標 ${macros.protein} g`;
  $("targetFatSmall").textContent = `目標 ${macros.fat} g`;
  $("targetCarbsSmall").textContent = `目標 ${macros.carbs} g`;
  $("calorieBalance").textContent = `${diff >= 0 ? "+" : ""}${diff} kcal`;
  $("balanceText").textContent =
    diff === 0
      ? "今日の目標カロリーとぴったりです。"
      : diff < 0
        ? `目標より${Math.abs(diff)} kcal少ない状態です。`
        : `目標より${diff} kcal多い状態です。`;

  $("calorieMeter").style.width = `${fillPercent}%`;
  $("targetMarker").style.left = `${targetPercent}%`;
  $("calorieMeter").style.background = diff > 250 ? "var(--coral)" : diff < -250 ? "var(--sun)" : "var(--mint)";
  setBar("protein", totals.protein, macros.protein);
  setBar("fat", totals.fat, macros.fat);
  setBar("carbs", totals.carbs, macros.carbs);
  renderRecentPhotos();
}

function setBar(name, current, target) {
  const percent = target ? Math.round((current / target) * 100) : 0;
  $(`${name}Percent`).textContent = `${formatGrams(current)} / ${target}g`;
  $(`${name}Bar`).style.width = `${Math.min(100, percent)}%`;
}

function renderRecentPhotos() {
  const photos = state.meals.filter((meal) => meal.photo).slice(-4).reverse();
  const strip = $("recentPhotos");
  if (!photos.length) {
    strip.className = "photo-strip empty-state";
    strip.textContent = "食事写真はまだありません。";
    return;
  }
  strip.className = "photo-strip";
  strip.innerHTML = photos.map((meal) => `<img src="${meal.photo}" alt="${escapeHtml(meal.name)}" />`).join("");
}

function renderMeals() {
  const list = $("mealList");
  if (!state.meals.length) {
    list.innerHTML = '<p class="empty-state">食事ログはまだありません。</p>';
    return;
  }

  list.innerHTML = [...state.meals]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(
      (meal) => `
      <article class="meal-card">
        ${meal.photo ? `<img src="${meal.photo}" alt="${escapeHtml(meal.name)}" />` : `<img alt="" />`}
        <div>
          <h3>${escapeHtml(meal.name)}</h3>
          <p class="meal-meta">${meal.date} / ${escapeHtml(meal.type)}${meal.note ? ` / ${escapeHtml(meal.note)}` : ""}</p>
          <div class="meal-nutrients">
            <span>${formatDecimal(meal.calories)} kcal</span>
            <span>P ${formatGrams(meal.protein)}g</span>
            <span>F ${formatGrams(meal.fat)}g</span>
            <span>C ${formatGrams(meal.carbs)}g</span>
          </div>
        </div>
        <div class="meal-actions">
          <button class="small-button" type="button" data-edit-meal="${meal.id}">編集</button>
          <button class="small-button danger" type="button" data-delete-meal="${meal.id}">削除</button>
        </div>
      </article>
    `
    )
    .join("");
}

function renderWeights() {
  const list = $("weightList");
  const sorted = [...state.weights].sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) {
    list.innerHTML = '<p class="empty-state">体重記録はまだありません。</p>';
  } else {
    list.innerHTML = sorted
      .map(
        (item) => `
        <div class="weight-row">
          <strong>${item.date}</strong>
          <span>${number(item.value).toFixed(1)} kg</span>
          <div class="row-actions">
            <button class="small-button" type="button" data-edit-weight="${item.date}">編集</button>
            <button class="small-button danger" type="button" data-delete-weight="${item.date}">削除</button>
          </div>
        </div>
      `
      )
      .join("");
  }
  renderWeightChart();
}

function renderWeightChart() {
  const svg = $("weightChart");
  const data = [...state.weights].sort((a, b) => a.date.localeCompare(b.date)).slice(-20);
  if (data.length < 2) {
    svg.innerHTML = '<text x="24" y="160" fill="#65716d" font-size="18">2件以上記録するとグラフが表示されます。</text>';
    return;
  }

  const values = data.map((item) => number(item.value));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const rawRange = Math.max(1, rawMax - rawMin);
  const tickStep = rawRange <= 3 ? 0.5 : rawRange <= 7 ? 1 : 2;
  const min = Math.floor((rawMin - tickStep) / tickStep) * tickStep;
  const max = Math.ceil((rawMax + tickStep) / tickStep) * tickStep;
  const width = 720;
  const height = 320;
  const padLeft = 58;
  const padRight = 24;
  const padTop = 28;
  const padBottom = 64;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const yFor = (value) => padTop + ((max - value) / (max - min)) * plotHeight;
  const xFor = (index) => padLeft + (index / (data.length - 1)) * plotWidth;
  const ticks = [];

  for (let tick = min; tick <= max + tickStep / 2; tick += tickStep) {
    ticks.push(Number(tick.toFixed(1)));
  }

  const points = data.map((item, index) => {
    const x = xFor(index);
    const y = yFor(number(item.value));
    return { x, y, item };
  });
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const labelEvery = Math.max(1, Math.ceil(data.length / 6));
  const dateLabel = (date) => date.slice(5).replace("-", "/");

  svg.innerHTML = `
    <line x1="${padLeft}" y1="${height - padBottom}" x2="${width - padRight}" y2="${height - padBottom}" stroke="#aebbb4" />
    <line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${height - padBottom}" stroke="#aebbb4" />
    ${ticks
      .map((tick) => {
        const y = yFor(tick);
        return `
          <line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" stroke="#dce4df" />
          <text x="${padLeft - 10}" y="${y + 4}" text-anchor="end" fill="#65716d" font-size="12">${tick.toFixed(1)}</text>
        `;
      })
      .join("")}
    ${points
      .map((point, index) => {
        if (index !== 0 && index !== points.length - 1 && index % labelEvery !== 0) return "";
        return `
          <line x1="${point.x}" y1="${height - padBottom}" x2="${point.x}" y2="${height - padBottom + 6}" stroke="#aebbb4" />
          <text x="${point.x}" y="${height - 28}" text-anchor="middle" fill="#65716d" font-size="12">${dateLabel(point.item.date)}</text>
        `;
      })
      .join("")}
    <text x="${padLeft}" y="18" fill="#65716d" font-size="12">kg</text>
    <text x="${width - padRight}" y="${height - 8}" text-anchor="end" fill="#65716d" font-size="12">日付</text>
    <polyline points="${line}" fill="none" stroke="#1f9d7a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
    ${points
      .map(
        (point) => `
      <circle cx="${point.x}" cy="${point.y}" r="5" fill="#1f9d7a" />
      <text x="${point.x}" y="${point.y - 12}" text-anchor="middle" fill="#17211f" font-size="12">${number(point.item.value).toFixed(1)}</text>
    `
      )
      .join("")}
  `;
}

function fillSettingsForm() {
  Object.entries(state.settings).forEach(([key, value]) => {
    if ($(key)) $(key).value = value;
  });
}

function setupDefaults() {
  $("todayDate").value = today();
  $("mealDate").value = today();
  $("weightDate").value = today();
  fillSettingsForm();
}

function resetMealForm() {
  $("mealForm").reset();
  $("editingMealId").value = "";
  $("mealDate").value = $("todayDate").value || today();
  $("mealPhoto").value = "";
  $("mealCamera").value = "";
  $("nutritionLabelPhotos").value = "";
  nutritionLabelPhotos = [];
  $("nutritionLabelStatus").textContent = "コンビニ商品などの栄養成分表示を最大4枚まで追加できます。";
  $("photoPreview").removeAttribute("src");
  document.querySelector(".photo-drop").classList.remove("has-image");
  $("photoHint").textContent = "写真を選択";
  $("mealSubmitButton").textContent = "保存";
  $("cancelMealEdit").classList.remove("is-visible");
  selectedPhoto = "";
}

function startMealEdit(meal) {
  nutritionLabelPhotos = [];
  $("nutritionLabelPhotos").value = "";
  $("nutritionLabelStatus").textContent = "コンビニ商品などの栄養成分表示を最大4枚まで追加できます。";
  $("editingMealId").value = meal.id;
  $("mealDate").value = meal.date;
  $("mealType").value = meal.type;
  $("mealName").value = meal.name;
  $("mealCalories").value = meal.calories;
  $("mealProtein").value = meal.protein;
  $("mealFat").value = meal.fat;
  $("mealCarbs").value = meal.carbs;
  $("mealNote").value = meal.note || "";
  selectedPhoto = meal.photo || "";

  if (selectedPhoto) {
    $("photoPreview").src = selectedPhoto;
    document.querySelector(".photo-drop").classList.add("has-image");
    $("photoHint").textContent = "写真を変更";
  } else {
    $("photoPreview").removeAttribute("src");
    document.querySelector(".photo-drop").classList.remove("has-image");
    $("photoHint").textContent = "写真を選択";
  }

  $("mealSubmitButton").textContent = "更新";
  $("cancelMealEdit").classList.add("is-visible");
  setStatus("mealStatus", `「${meal.name}」を編集中です。`);
  setView("meal");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function syncBodyWeightFromLatestWeight() {
  const latest = [...state.weights].sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!latest) return;
  state.settings.bodyWeight = number(latest.value);
  $("bodyWeight").value = state.settings.bodyWeight;
}

function resetWeightForm() {
  $("editingWeightDate").value = "";
  $("weightDate").value = today();
  $("weightValue").value = "";
  $("weightSubmitButton").textContent = "記録";
  $("cancelWeightEdit").classList.remove("is-visible");
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderAll() {
  renderDashboard();
  renderMeals();
  renderWeights();
}

async function handlePhotoSelection(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (!isLikelyImage(file)) {
    setStatus("mealStatus", "画像ファイルを選択してください。", "error");
    event.target.value = "";
    return;
  }

  setStatus("mealStatus", `${file.name || "写真"} を読み込んでいます。`);

  try {
    const dataUrl = await readFileAsDataUrl(file);
    selectedPhoto = await resizeImage(dataUrl);
    $("photoPreview").src = selectedPhoto;
    document.querySelector(".photo-drop").classList.add("has-image");
    $("photoHint").textContent = "写真を変更";
    setStatus("mealStatus", `${file.name || "写真"} を選択しました。`);
  } catch (error) {
    selectedPhoto = "";
    $("photoPreview").removeAttribute("src");
    document.querySelector(".photo-drop").classList.remove("has-image");
    $("photoHint").textContent = "写真を選択";
    setStatus("mealStatus", "写真を読み込めませんでした。JPEGまたはPNGで試してください。", "error");
  } finally {
    event.target.value = "";
  }
}

async function handleNutritionLabelSelection(event) {
  const files = [...event.target.files].slice(0, 4);
  if (!files.length) return;
  if (files.some((file) => !isLikelyImage(file))) {
    setStatus("mealStatus", "栄養成分表示には画像ファイルを選択してください。", "error");
    event.target.value = "";
    return;
  }

  setStatus("mealStatus", "栄養成分表示の写真を読み込んでいます。");
  try {
    nutritionLabelPhotos = await Promise.all(
      files.map(async (file) => resizeImage(await readFileAsDataUrl(file), 1400, 0.82))
    );
    $("nutritionLabelStatus").textContent =
      `${nutritionLabelPhotos.length}枚の栄養成分表示を追加しました。AIが記載値を読み取って合計します。`;
    setStatus("mealStatus", "栄養成分表示の写真を追加しました。");
  } catch (error) {
    nutritionLabelPhotos = [];
    $("nutritionLabelStatus").textContent = "栄養成分表示の写真を読み込めませんでした。";
    setStatus("mealStatus", "栄養成分表示の写真を読み込めませんでした。", "error");
  } finally {
    event.target.value = "";
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setView(tab.dataset.view));
});

$("todayDate").addEventListener("change", renderDashboard);

$("mealPhoto").addEventListener("change", handlePhotoSelection);
$("mealCamera").addEventListener("change", handlePhotoSelection);
$("nutritionLabelPhotos").addEventListener("change", handleNutritionLabelSelection);

function formatConfidence(value) {
  return `${Math.round(number(value) * 100)}%`;
}

$("estimateButton").addEventListener("click", async () => {
  const analysisDetails = $("mealAnalysisDetails").value.trim();
  if (!selectedPhoto && !nutritionLabelPhotos.length && !analysisDetails) {
    setStatus("mealStatus", "食事写真、栄養成分表示、または食材と分量を入力してください。", "error");
    return;
  }
  if (!cloudReady || !cloudClient) {
    setStatus("mealStatus", "AI解析を使うにはSupabase設定が必要です。", "error");
    return;
  }
  if (!cloudUser) {
    setStatus("mealStatus", "AI解析を使うには設定画面からログインしてください。", "error");
    return;
  }

  const button = $("estimateButton");
  button.disabled = true;
  button.textContent = "AIが計算中...";
  setStatus(
    "mealStatus",
    nutritionLabelPhotos.length
      ? "栄養成分表示を読み取り、食べた量に合わせて計算しています。"
      : selectedPhoto
        ? "写真と入力した分量から計算しています。"
        : "入力した食材と分量から計算しています。"
  );

  try {
    const { data, error } = await cloudClient.functions.invoke("analyze-meal", {
      body: {
        image: selectedPhoto,
        labelImages: nutritionLabelPhotos,
        hint: $("mealName").value.trim(),
        details: analysisDetails,
      },
    });
    if (error) {
      let context = null;
      try {
        context = error.context?.json ? await error.context.json() : null;
      } catch {
        context = null;
      }
      throw new Error(context?.error || error.message);
    }
    if (!data || typeof data !== "object") throw new Error("Invalid AI response");
    if (data.error) throw new Error(data.error);

    $("mealName").value = data.name || "";
    $("mealCalories").value = number(data.calories);
    $("mealProtein").value = number(data.protein);
    $("mealFat").value = number(data.fat);
    $("mealCarbs").value = number(data.carbs);

    const details = Array.isArray(data.items) ? data.items.join("、") : "";
    const assumptions = Array.isArray(data.assumptions) ? data.assumptions.join("、") : "";
    $("mealNote").value = [
      `AI栄養推定（信頼度 ${formatConfidence(data.confidence)}）`,
      nutritionLabelPhotos.length ? `読み取った栄養成分表示: ${nutritionLabelPhotos.length}枚` : "",
      analysisDetails ? `入力した食材・分量: ${analysisDetails}` : "",
      details ? `推定した内容: ${details}` : "",
      assumptions ? `注意点: ${assumptions}` : "",
      "数値を確認してから保存してください。",
    ]
      .filter(Boolean)
      .join("\n");
    setStatus("mealStatus", "AI推定が完了しました。内容と量を確認してから保存してください。");
  } catch (error) {
    console.error("AI meal analysis failed", error);
    setStatus(
      "mealStatus",
      `AI解析に失敗しました。${error instanceof Error ? error.message : "しばらく待って再試行してください。"}`,
      "error"
    );
  } finally {
    button.disabled = false;
    button.textContent = "AIで計算・写真解析";
  }
});

$("mealForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const editingId = $("editingMealId").value;
  const existingMeal = editingId ? state.meals.find((item) => item.id === editingId) : null;
  const meal = {
    id: existingMeal?.id || createId(),
    createdAt: existingMeal?.createdAt || new Date().toISOString(),
    date: $("mealDate").value,
    type: $("mealType").value,
    name: $("mealName").value,
    calories: number($("mealCalories").value),
    protein: number($("mealProtein").value),
    fat: number($("mealFat").value),
    carbs: number($("mealCarbs").value),
    note: $("mealNote").value.trim(),
    photo: selectedPhoto,
    photoPath: existingMeal?.photoPath || "",
  };
  const previousMeals = [...state.meals];
  state.meals = existingMeal
    ? state.meals.map((item) => (item.id === meal.id ? meal : item))
    : [...state.meals, meal];
  if (!saveState()) {
    state.meals = previousMeals;
    setStatus("mealStatus", "保存できませんでした。写真を外すか、小さい写真で試してください。", "error");
    return;
  }
  try {
    await saveMealToCloud(meal);
    saveState();
  } catch (error) {
    state.meals = previousMeals;
    saveState();
    setStatus("mealStatus", "クラウドに保存できませんでした。接続とSupabase設定を確認してください。", "error");
    return;
  }
  resetMealForm();
  renderAll();
  setStatus("mealStatus", `${meal.date} の食事「${meal.name}」を${existingMeal ? "更新" : "保存"}しました。`);
  setView(existingMeal ? "history" : "dashboard");
});

$("mealList").addEventListener("click", async (event) => {
  const editId = event.target.dataset.editMeal;
  const deleteId = event.target.dataset.deleteMeal;

  if (editId) {
    const meal = state.meals.find((item) => item.id === editId);
    if (meal) startMealEdit(meal);
    return;
  }

  if (deleteId) {
    const meal = state.meals.find((item) => item.id === deleteId);
    if (!meal || !window.confirm(`「${meal.name}」を削除しますか？`)) return;

    const previousMeals = [...state.meals];
    state.meals = state.meals.filter((item) => item.id !== deleteId);
    if (!(await deleteMealFromCloud(meal))) {
      state.meals = previousMeals;
      setStatus("mealStatus", "クラウドから削除できませんでした。", "error");
      return;
    }
    if (!saveState()) {
      state.meals = previousMeals;
      setStatus("mealStatus", "削除を保存できませんでした。", "error");
      return;
    }
    if ($("editingMealId").value === deleteId) resetMealForm();
    renderAll();
  }
});

$("cancelMealEdit").addEventListener("click", () => {
  resetMealForm();
  setStatus("mealStatus", "編集を取り消しました。");
});

$("weightForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const date = $("weightDate").value;
  const value = number($("weightValue").value);
  const editingDate = $("editingWeightDate").value;
  const existed = state.weights.some((item) => item.date === date || item.date === editingDate);
  state.weights = state.weights.filter((item) => item.date !== date && item.date !== editingDate);
  state.weights.push({ date, value });
  state.settings.bodyWeight = value;
  $("bodyWeight").value = value;
  if (!saveState()) {
    setStatus("weightStatus", "体重を保存できませんでした。ブラウザの保存領域を確認してください。", "error");
    return;
  }
  if (!(await saveWeightToCloud(date, value, editingDate))) {
    setStatus("weightStatus", "クラウドに体重を保存できませんでした。", "error");
    return;
  }
  renderAll();
  resetWeightForm();
  setStatus("weightStatus", `${date} の体重 ${value.toFixed(1)} kg を${existed ? "上書き保存" : "保存"}しました。`);
});

$("weightList").addEventListener("click", async (event) => {
  const editDate = event.target.dataset.editWeight;
  const deleteDate = event.target.dataset.deleteWeight;

  if (editDate) {
    const item = state.weights.find((weight) => weight.date === editDate);
    if (!item) return;
    $("editingWeightDate").value = item.date;
    $("weightDate").value = item.date;
    $("weightValue").value = number(item.value).toFixed(1);
    $("weightSubmitButton").textContent = "更新";
    $("cancelWeightEdit").classList.add("is-visible");
    setStatus("weightStatus", `${item.date} の体重を編集中です。`);
    return;
  }

  if (deleteDate) {
    state.weights = state.weights.filter((weight) => weight.date !== deleteDate);
    syncBodyWeightFromLatestWeight();
    if (!(await deleteWeightFromCloud(deleteDate))) {
      setStatus("weightStatus", "クラウドから削除できませんでした。", "error");
      return;
    }
    if (!saveState()) {
      setStatus("weightStatus", "削除を保存できませんでした。", "error");
      return;
    }
    renderAll();
    resetWeightForm();
    setStatus("weightStatus", `${deleteDate} の体重記録を削除しました。`);
  }
});

$("cancelWeightEdit").addEventListener("click", () => {
  resetWeightForm();
  setStatus("weightStatus", "編集を取り消しました。");
});

$("settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.settings = {
    sex: $("sex").value,
    age: number($("age").value),
    height: number($("height").value),
    bodyWeight: number($("bodyWeight").value),
    activity: number($("activity").value),
    goal: $("goal").value,
    calorieOffset: number($("calorieOffset").value),
    manualTdee: $("manualTdee").value ? number($("manualTdee").value) : "",
  };
  if (!saveState()) {
    return;
  }
  if (!(await saveSettingsToCloud())) {
    setStatus("authStatus", "設定をクラウドに保存できませんでした。", "error");
    return;
  }
  renderAll();
  setView("dashboard");
});

$("sendLoginLink").addEventListener("click", async () => {
  if (!cloudReady) {
    setStatus("authStatus", "Supabase設定がまだ入っていません。", "error");
    return;
  }

  const email = $("authEmail").value.trim();
  if (!email) {
    setStatus("authStatus", "メールアドレスを入力してください。", "error");
    return;
  }

  const { error } = await cloudClient.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: location.href.split("#")[0],
    },
  });

  setStatus(
    "authStatus",
    error ? "ログインリンクを送信できませんでした。Supabase設定を確認してください。" : "ログインリンクをメールで送信しました。",
    error ? "error" : "success"
  );
});

$("signOutButton").addEventListener("click", async () => {
  if (!cloudReady) return;
  await cloudClient.auth.signOut();
  cloudUser = null;
  updateAuthUi();
  setStatus("authStatus", "ログアウトしました。");
});

setupDefaults();
renderAll();
setupCloudAuth();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
