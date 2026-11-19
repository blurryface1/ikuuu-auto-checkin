import { appendFileSync } from "fs";

// 内置候选域名，优先级从高到低；HOST 环境变量可覆盖，多个域名用逗号分隔
const DEFAULT_HOSTS = ["ikuuu.top", "ikuuu.pw"];

const LOGIN_HINT = "Cookie 已失效或登录态无效，请在当前域名重新获取 Cookie";

// 规范化域名，去除协议头与首尾斜杠
function normalizeHost(value) {
  return value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

// 计算本次运行的候选域名列表，HOST 优先于内置默认值
function resolveHosts() {
  const configured = (process.env.HOST || "")
    .split(",")
    .map(normalizeHost)
    .filter(Boolean);

  return configured.length > 0 ? configured : DEFAULT_HOSTS;
}

// 请求单个域名的签到接口，返回接口提示语
async function requestCheckIn(host, cookie) {
  const response = await fetch(`https://${host}/user/checkin`, {
    method: "POST",
    headers: {
      Cookie: cookie,
    },
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400) {
    const error = new Error(`${LOGIN_HINT}（${host} 返回 ${response.status}，跳转到登录页）`);
    error.fatal = true;
    throw error;
  }

  if (!response.ok) {
    throw new Error(`${host} 请求失败 - ${response.status}`);
  }

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${host} 返回内容不是 JSON，域名可能已失效 - ${text.slice(0, 60)}`);
  }

  if (!data || !data.msg) {
    throw new Error(`${host} 返回内容缺少 msg 字段 - ${text.slice(0, 60)}`);
  }

  return data.msg;
}

// 依次尝试候选域名完成签到，Cookie 失效时立即终止
async function checkIn(account, hosts) {
  let lastError;

  for (const host of hosts) {
    try {
      return await requestCheckIn(host, account.cookie);
    } catch (error) {
      if (error.fatal) {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError;
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
