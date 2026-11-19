import { appendFileSync } from "fs";

// 内置面板候选域名，优先级从高到低；HOST 环境变量可覆盖，多个域名用英文逗号分隔
const KNOWN_HOSTS = ["ikuuu.top", "ikuuu.pw"];

// 公告页域名，这些页面发布最新面板地址，本身不提供签到接口
const INDEX_HOSTS = ["ikuuu.win", "ikuuu.ch", "ikuuu.fyi", "ikuuu.de", "ikuuu.nl"];

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT = 15000;

// Cookie 失效的标记，命中后立即终止，不再尝试其它域名
const CODE_LOGIN = "LOGIN";

let discoveredHosts = null;

// 规范化域名，去除协议头与首尾斜杠
function normalizeHost(value) {
  return value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

// 计算主要候选域名，HOST 优先于内置默认值
function resolveHosts() {
  const configured = (process.env.HOST || "")
    .split(",")
    .map(normalizeHost)
    .filter(Boolean);

  return configured.length > 0 ? configured : KNOWN_HOSTS;
}

function createError(message, code) {
  const error = new Error(message);
  error.code = code;

  return error;
}

// 从公告页的 DOMAINS 配置中解析面板域名
function parsePanelHosts(html) {
  const block = html.match(/const\s+DOMAINS\s*=\s*\[([\s\S]*?)\];/);
  const scope = block ? block[1] : html;
  const hosts = new Set();

  for (const match of scope.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const host = match[1].toLowerCase();

    if (INDEX_HOSTS.includes(host) || host.endsWith(".zstatic.net")) {
      continue;
    }

    hosts.add(host);
  }

  return [...hosts];
}

// 读取公告页，发现当前面板域名，结果在本次运行内缓存
async function discoverHosts() {
  if (discoveredHosts) {
    return discoveredHosts;
  }

  const found = new Set();

  for (const indexHost of INDEX_HOSTS) {
    try {
      const response = await fetch(`https://${indexHost}/`, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });

      if (!response.ok) {
        continue;
      }

      parsePanelHosts(await response.text()).forEach((host) => found.add(host));
    } catch {
      // 单个公告页失败不影响其它来源
    }

    if (found.size > 0) {
      break;
    }
  }

  discoveredHosts = [...found];

  return discoveredHosts;
}

// 请求单个域名的签到接口，返回接口提示语
async function requestCheckIn(host, cookie) {
  let response;

  try {
    response = await fetch(`https://${host}/user/checkin`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "User-Agent": USER_AGENT,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
  } catch (error) {
    throw createError(`${host} 网络异常 - ${error.message}`, "SKIP");
  }

  if (response.status >= 300 && response.status < 400) {
    throw createError(
      `Cookie 已失效或登录态无效，请用当前域名重新获取 Cookie 后更新 ACCOUNTS（${host} 返回 ${response.status}，跳转到登录页）`,
      CODE_LOGIN,
    );
  }

  if (!response.ok) {
    throw createError(`${host} 请求失败 - ${response.status}`, "SKIP");
  }

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw createError(`${host} 返回内容不是 JSON，域名可能已失效 - ${text.slice(0, 60)}`, "SKIP");
  }

  if (!data || !data.msg) {
    throw createError(`${host} 返回内容缺少 msg 字段 - ${text.slice(0, 60)}`, "SKIP");
  }

  return data.msg;
}

// 依次尝试一组域名，Cookie 失效时立即返回
async function tryHosts(account, hosts) {
  let lastError;

  for (const host of hosts) {
    try {
      return { ok: true, msg: await requestCheckIn(host, account.cookie) };
    } catch (error) {
      lastError = error;

      if (error.code === CODE_LOGIN) {
        return { ok: false, error };
      }
    }
  }

  return { ok: false, error: lastError };
}

// 主要域名全部不可用时，用公告页发现的域名做兜底
async function checkIn(account, hosts) {
  const primary = await tryHosts(account, hosts);

  if (primary.ok) {
    return primary.msg;
  }

  if (primary.error.code === CODE_LOGIN) {
    throw primary.error;
  }

  const tried = [...hosts];
  const discovered = (await discoverHosts()).filter((host) => !tried.includes(host));

  if (discovered.length > 0) {
    const fallback = await tryHosts(account, discovered);

    if (fallback.ok) {
      return fallback.msg;
    }

    if (fallback.error.code === CODE_LOGIN) {
      throw fallback.error;
    }

    tried.push(...discovered);
  }

  throw createError(
    `所有候选域名均不可用（已尝试 ${tried.join("、")}）。请打开 https://ikuuu.win 或 https://ikuuu.ch 查看最新域名，并更新 HOST 或脚本中的候选域名。`,
    "SKIP",
  );
}

// 处理单个账号
async function processSingleAccount(account, hosts) {
  const checkInResult = await checkIn(account, hosts);

  return checkInResult;
}

function setGitHubOutput(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF\n${value}\nEOF\n`);
}

// 入口
async function main() {

  let accounts;

  try {
    if (!process.env.ACCOUNTS) {
      throw new Error("❌ 未配置账户信息。");
    }

    accounts = JSON.parse(process.env.ACCOUNTS);
  } catch (error) {
    const message = `❌ ${error.message.includes("JSON") ? "账户信息配置格式错误。" : error.message
      }`;
    console.error(message);
    setGitHubOutput("result", message);
    process.exit(1);
  }

  const hosts = resolveHosts();
  console.log(`候选域名：${hosts.join("、")}`);

  const allPromises = accounts.map((account) => processSingleAccount(account, hosts));
  const results = await Promise.allSettled(allPromises);

  const msgHeader = "\n======== 签到结果 ========\n\n";
  console.log(msgHeader);

  let hasError = false;

  const resultLines = results.map((result, index) => {
    const accountName = accounts[index].name;

    const isSuccess = result.status === "fulfilled";

    if (!isSuccess) {
      hasError = true;
    }

    const icon = isSuccess ? "✅" : "❌";
    const message = isSuccess ? result.value : result.reason.message;

    const line = `${accountName}: ${icon} ${message}`;

    isSuccess ? console.log(line) : console.error(line);

    return line;
  });

  const resultMsg = resultLines.join("\n");

  setGitHubOutput("result", resultMsg);

  if (hasError) {
    process.exit(1);
  }
}

main();
