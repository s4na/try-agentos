import { AgentOs } from "@rivet-dev/agent-os-core";
import common from "@rivet-dev/agent-os-common";
import pi from "@rivet-dev/agent-os-pi";

// --- 環境変数 ---
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PR_NUMBER = process.env.PR_NUMBER;
const REPO = process.env.GITHUB_REPOSITORY; // "owner/repo"

if (!ANTHROPIC_API_KEY || !GITHUB_TOKEN || !PR_NUMBER || !REPO) {
  console.error("必要な環境変数が不足しています");
  process.exit(1);
}

// --- PR の diff を取得 ---
async function fetchPRDiff(): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3.diff",
      },
    }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const diff = await res.text();
  // diff が巨大すぎる場合は先頭を切る
  const MAX_CHARS = 30_000;
  return diff.length > MAX_CHARS
    ? diff.slice(0, MAX_CHARS) + "\n...(truncated)"
    : diff;
}

// --- メイン ---
async function main() {
  const diff = await fetchPRDiff();
  console.log(`差分取得完了: ${diff.length} chars`);

  // agentOS VM を起動
  const vm = await AgentOs.create({
    software: [common, pi],
  });

  // エージェントセッションを作成
  const { sessionId } = await vm.createSession("pi", {
    env: {
      ANTHROPIC_API_KEY,
    },
  });

  // イベントを収集
  let reviewOutput = "";
  vm.onSessionEvent(sessionId, (event: any) => {
    // テキスト出力イベントを収集（イベント構造は実際の API に合わせて調整すること）
    if (event.type === "text" || event.type === "output") {
      reviewOutput += event.text ?? event.data ?? "";
    }
    // デバッグ用
    console.log(JSON.stringify(event));
  });

  // プロンプトを送信
  const prompt = `あなたはコードレビュアーです。以下の PR diff を読み、問題点や改善提案を簡潔にまとめてください。
日本語で回答してください。重大な問題があれば先に述べ、軽微な指摘は後にまとめてください。

\`\`\`diff
${diff}
\`\`\``;

  await vm.prompt(sessionId, prompt);

  // セッション終了・VM 破棄
  vm.closeSession(sessionId);
  await vm.dispose();

  // --- GitHub にコメント投稿 ---
  if (reviewOutput.trim()) {
    const comment = `## 🤖 agentOS レビュー\n\n${reviewOutput}`;
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/issues/${PR_NUMBER}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body: comment }),
      }
    );
    if (!res.ok) {
      console.error(`コメント投稿失敗: ${res.status}`);
      process.exit(1);
    }
    console.log("レビューコメントを投稿しました");
  } else {
    console.warn("エージェントからの出力が空でした");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
