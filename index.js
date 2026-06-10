// ============================
// Fallback khi không có KV namespace: lưu cooldown trong bộ nhớ toàn cục
// ============================
const globalCooldownMap = new Map(); // key -> timestamp hết cooldown

// ============================
// Hàm tiện ích
// ============================

/**
 * Kiểm tra một API key có đang trong thời gian chờ (cooldown) hay không.
 */
async function isKeyOnCooldown(key, kvAvailable, kv) {
  if (kvAvailable) {
    const val = await kv.get('cooldown:' + key);
    return val !== null;
  } else {
    // Fallback: kiểm tra bộ nhớ toàn cục
    const until = globalCooldownMap.get(key);
    if (!until) return false;
    if (Date.now() > until) {
      globalCooldownMap.delete(key);
      return false;
    }
    return true;
  }
}

/**
 * Đánh dấu một API key đang lỗi và không dùng trong `ttlSeconds` giây.
 */
function setKeyCooldown(key, ttlSeconds, kvAvailable, kv, ctx) {
  if (kvAvailable) {
    // Ghi vào KV với TTL, không cần chờ kết quả
    ctx.waitUntil(kv.put('cooldown:' + key, '1', { expirationTtl: ttlSeconds }));
  } else {
    // Fallback: lưu timestamp hết hạn
    globalCooldownMap.set(key, Date.now() + ttlSeconds * 1000);
  }
}

/**
 * Lấy chỉ số round‑robin hiện tại từ KV (mặc định 0).
 */
async function getRoundRobinIndex(kvAvailable, kv) {
  if (!kvAvailable) return 0; // fallback: bắt đầu từ 0
  const val = await kv.get('round_robin_index');
  return val ? parseInt(val, 10) : 0;
}

/**
 * Cập nhật chỉ số round‑robin, không cần đợi.
 */
function setRoundRobinIndex(index, kvAvailable, kv, ctx) {
  if (kvAvailable) {
    ctx.waitUntil(kv.put('round_robin_index', String(index)));
  }
  // fallback: không lưu index (mỗi request chọn ngẫu nhiên, nhưng ta vẫn giữ nguyên logic round‑robin bằng biến trong request)
}

// ============================
// Xử lý request chính
// ============================
export default {
  async fetch(request, env, ctx) {
    // 1. Xử lý CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    // 2. Quét tất cả API Keys (dạng OPENROUTER_KEY_X)
    const apiKeys = [];
    for (const key in env) {
      if (key.startsWith('OPENROUTER_KEY_') && env[key]?.trim()) {
        apiKeys.push(env[key].trim());
      }
    }

    if (apiKeys.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Chưa cấu hình API Key nào dạng OPENROUTER_KEY_X trong Settings!' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3. Chuẩn bị KV (nếu có) và fallback
    const kvAvailable = !!env.OPENROUTER_KV;
    const kv = env.OPENROUTER_KV; // có thể undefined

    // 4. Lấy chỉ số round‑robin hiện tại
    let currentIndex = await getRoundRobinIndex(kvAvailable, kv);
    currentIndex = currentIndex % apiKeys.length;

    // 5. Lọc nhanh các key đang cooldown (dùng Promise.all để kiểm tra song song)
    const cooldownChecks = apiKeys.map(key => isKeyOnCooldown(key, kvAvailable, kv));
    const cooldownResults = await Promise.all(cooldownChecks);
    const availableKeys = apiKeys.filter((_, idx) => !cooldownResults[idx]);

    // Nếu không còn key nào khả dụng
    if (availableKeys.length === 0) {
      return new Response(
        JSON.stringify({
          error: 'Tất cả API key đều đang bị giới hạn (rate limited), vui lòng thử lại sau.',
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    // 6. Xử lý path thông minh (giữ nguyên logic cũ)
    const url = new URL(request.url);
    let cleanPath = url.pathname;
    if (cleanPath.startsWith('/api')) cleanPath = cleanPath.slice(4);
    if (cleanPath.startsWith('/v1')) cleanPath = cleanPath.slice(3);
    const openRouterUrl = `https://openrouter.ai/api/v1${cleanPath}${url.search}`;

    // 7. Thử lần lượt các key theo vòng tròn, bắt đầu từ currentIndex
    let lastError = null;
    let successResponse = null;
    let usedKeyIndex = -1; // vị trí của key đã dùng thành công trong mảng apiKeys

    for (let attempt = 0; attempt < apiKeys.length; attempt++) {
      const idx = (currentIndex + attempt) % apiKeys.length;
      const key = apiKeys[idx];

      // Bỏ qua key đang cooldown (đã lọc trước đó, nhưng có thể có key mới bị đánh dấu trong quá trình thử)
      if (cooldownResults[idx]) continue; // đã kiểm tra trước vòng lặp, nhưng an toàn thêm

      // Tạo request với key hiện tại
      const modifiedHeaders = new Headers(request.headers);
      modifiedHeaders.set('Authorization', `Bearer ${key}`);
      modifiedHeaders.set('Access-Control-Allow-Origin', '*');

      const modifiedRequest = new Request(openRouterUrl, {
        method: request.method,
        headers: modifiedHeaders,
        body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
        redirect: 'follow',
      });

      try {
        const response = await fetch(modifiedRequest);

        // Thành công hoặc lỗi không nên thử lại (ví dụ 4xx trừ 429)
        if (response.ok || (response.status >= 400 && response.status !== 429 && response.status < 500)) {
          // Không phải rate limit hay lỗi server -> trả về ngay
          const newHeaders = new Headers(response.headers);
          newHeaders.set('Access-Control-Allow-Origin', '*');
          successResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
          usedKeyIndex = idx;
          break;
        }

        // Rate limit (429) hoặc lỗi server (5xx) => thử key khác
        if (response.status === 429 || response.status >= 500) {
          // Lấy thời gian chờ từ header Retry-After nếu có (tính bằng giây)
          let cooldownSeconds = 30; // mặc định 30s
          const retryAfter = response.headers.get('Retry-After');
          if (retryAfter) {
            const parsed = parseInt(retryAfter, 10);
            if (!isNaN(parsed)) cooldownSeconds = Math.min(parsed, 300); // giới hạn tối đa 5 phút
          }
          // Đánh dấu key này cần nghỉ
          setKeyCooldown(key, cooldownSeconds, kvAvailable, kv, ctx);
          // Lưu lỗi cuối cùng để trả về nếu hết key
          lastError = {
            status: response.status,
            body: await response.text(),
          };
          continue; // thử key tiếp theo
        }
      } catch (error) {
        // Lỗi kết nối (network error) – cũng nên cooldown key một thời gian ngắn
        setKeyCooldown(key, 10, kvAvailable, kv, ctx); // nghỉ 10s
        lastError = {
          status: 502,
          body: JSON.stringify({ error: 'Lỗi kết nối proxy', details: error.message }),
        };
        continue;
      }
    }

    // 8. Cập nhật chỉ số round‑robin cho lần sau (tăng 1 so với vị trí bắt đầu)
    const nextIndex = (currentIndex + 1) % apiKeys.length;
    setRoundRobinIndex(nextIndex, kvAvailable, kv, ctx);

    // 9. Trả về kết quả
    if (successResponse) {
      return successResponse;
    }

    // Nếu không key nào thành công, trả về lỗi cuối cùng (rate limit hoặc kết nối)
    if (lastError) {
      return new Response(lastError.body, {
        status: lastError.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // Trường hợp không mong đợi (tất cả key cooldown nhưng availableKeys lại rỗng – đã xử lý ở trên)
    return new Response(
      JSON.stringify({ error: 'Không thể gọi OpenRouter, vui lòng thử lại sau.' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );
  },
};
