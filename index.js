export default {
  async fetch(request, env, ctx) {
    // 1. Xử lý CORS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    // 2. Tự động quét toàn bộ API Keys dạng OPENROUTER_KEY_X trong Settings
    const apiKeys = [];
    for (const key in env) {
      if (key.startsWith("OPENROUTER_KEY_") && env[key] && env[key].trim() !== "") {
        apiKeys.push(env[key].trim());
      }
    }

    if (apiKeys.length === 0) {
      return new Response(
        JSON.stringify({ error: "Chưa cấu hình API Key nào dạng OPENROUTER_KEY_X trong Settings!" }), 
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Chọn ngẫu nhiên một API Key để chia tải
    const randomIndex = Math.floor(Math.random() * apiKeys.length);
    const selectedApiKey = apiKeys[randomIndex];

    // 4. XỬ LÝ PATH THÔNG MINH (SỬA LỖI 404)
    const url = new URL(request.url);
    let cleanPath = url.pathname;
    
    // Loại bỏ các tiền tố trùng lặp do App tự động thêm vào nếu có
    if (cleanPath.startsWith("/api")) {
      cleanPath = cleanPath.slice(4);
    }
    if (cleanPath.startsWith("/v1")) {
      cleanPath = cleanPath.slice(3);
    }
    
    // Ép buộc đưa về đúng format endpoint chuẩn của OpenRouter
    const openRouterUrl = `https://openrouter.ai/api/v1${cleanPath}${url.search}`;

    // 5. Ghi đè Header Authorization bằng Key đã chọn
    const modifiedHeaders = new Headers(request.headers);
    modifiedHeaders.set("Authorization", `Bearer ${selectedApiKey}`);
    modifiedHeaders.set("Access-Control-Allow-Origin", "*");

    const modifiedRequest = new Request(openRouterUrl, {
      method: request.method,
      headers: modifiedHeaders,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      redirect: "follow"
    });

    try {
      // 6. Tiến hành gọi OpenRouter
      const response = await fetch(modifiedRequest);
      
      const newResponseHeaders = new Headers(response.headers);
      newResponseHeaders.set("Access-Control-Allow-Origin", "*");
      
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newResponseHeaders
      });

    } catch (error) {
      return new Response(
        JSON.stringify({ error: "Lỗi kết nối proxy", details: error.message }), 
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
