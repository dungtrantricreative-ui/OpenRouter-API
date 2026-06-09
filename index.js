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

    // 2. TỰ ĐỘNG QUÉT VÔ HẠN: Lấy toàn bộ keys trong biến môi trường
    const apiKeys = [];
    
    // Duyệt qua tất cả các key đang có trong Settings của Worker
    for (const key in env) {
      if (key.startsWith("OPENROUTER_KEY_") && env[key] && env[key].trim() !== "") {
        apiKeys.push(env[key].trim());
      }
    }

    // Kiểm tra nếu không tìm thấy API Key nào
    if (apiKeys.length === 0) {
      return new Response(
        JSON.stringify({ error: "Không tìm thấy API Key nào dạng OPENROUTER_KEY_X trong Settings!" }), 
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Chọn ngẫu nhiên một API Key để bypass limit
    const randomIndex = Math.floor(Math.random() * apiKeys.length);
    const selectedApiKey = apiKeys[randomIndex];

    // 4. Định tuyến URL đến OpenRouter
    const url = new URL(request.url);
    const openRouterUrl = `https://openrouter.ai/api${url.pathname}${url.search}`;

    // 5. Ghi đè Header Authorization
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
      // 6. Gửi request và trả kết quả về
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
