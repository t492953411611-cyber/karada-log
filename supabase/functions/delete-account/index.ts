import { createClient } from "npm:@supabase/supabase-js@2";

const bucketName = "meal-photos";
const allowedOrigins = new Set([
  "https://t492953411611-cyber.github.io",
  "http://localhost:8000",
  "capacitor://localhost",
]);

function corsHeaders(request: Request) {
  const origin = request.headers.get("Origin") || "";
  return {
    ...(allowedOrigins.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function jsonResponse(request: Request, body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json" },
  });
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

async function removeFolderObjects(
  adminClient: ReturnType<typeof createClient>,
  folder: string
): Promise<void> {
  for (;;) {
    const { data: entries, error: listError } = await adminClient.storage
      .from(bucketName)
      .list(folder, { limit: 1000, sortBy: { column: "name", order: "asc" } });

    if (listError) throw listError;
    if (!entries?.length) return;

    const filePaths: string[] = [];
    const childFolders: string[] = [];
    for (const entry of entries) {
      const path = `${folder}/${entry.name}`;
      if (entry.id) {
        filePaths.push(path);
      } else {
        childFolders.push(path);
      }
    }

    for (const childFolder of childFolders) {
      await removeFolderObjects(adminClient, childFolder);
    }

    if (filePaths.length) {
      const { error: removeError } = await adminClient.storage.from(bucketName).remove(filePaths);
      if (removeError) throw removeError;
    }
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "Method not allowed" }, 405);
  }

  const token = getBearerToken(request);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!token || !supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return jsonResponse(request, { error: "Authentication is required" }, 401);
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const {
    data: { user },
    error: userError,
  } = await authClient.auth.getUser(token);
  if (userError || !user) {
    return jsonResponse(request, { error: "Authentication is required" }, 401);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    // Storage must be cleared before Auth user deletion. Repeated calls are safe when no files remain.
    await removeFolderObjects(adminClient, user.id);

    const { error: deleteUserError } = await adminClient.auth.admin.deleteUser(user.id, false);
    if (deleteUserError) throw deleteUserError;

    return jsonResponse(request, { ok: true });
  } catch (error) {
    console.error("Failed to delete account", error);
    return jsonResponse(request, { error: "Account deletion failed" }, 500);
  }
});
