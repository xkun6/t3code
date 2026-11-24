# T3 Code 中文版(zh 分支)

`zh` 分支是上游 [pingdotgg/t3code](https://github.com/pingdotgg/t3code) 的 fork:上游稳定版 + 中文化提交。

- `zh/UPSTREAM`:已经合并进来的上游标签。
- `.github/workflows/zh-release.yml`:每小时检查上游最新稳定版(`vX.Y.Z` 标签),比 `zh/UPSTREAM` 新就合并进 `zh`、翻译新增文案、构建、发布。上游自己的 workflow 在本分支里都删掉了,合并时也会自动丢弃,只跑这一个。
- dsh-bot 的 t3code 插件(另一个仓库 `dsh-t3code`)轮询这个 workflow,把开始、完成、失败发给你,也能用 `/t3 构建` 立即触发。
- `zh/`:中文化与增强覆盖层。不改上游业务源码,只在构建/入口配置里各有一两行带 `t3code-zh-overlay` 标记的正式提交(Web、桌面端、服务端的 Vite 配置,服务端开发入口,移动端的 Metro 配置,安卓原生底部栏):
  - 构建时把界面里的英文字符串替换成 `zh/locales/zh-Hans.json` 里的翻译。
  - 服务端兼容 Reclaude(`rec` / `reclaude`)与 Recodex(`recx` / `recodex`)封装 CLI:在 **设置 → 提供商 → Claude / Codex → 二进制路径** 填入 `rec`(`rec.exe`)或 `recx`(`recx.exe`)即可直接使用,自动透传 `cli` 子命令与前置 `--org <id>` 参数、对齐 `~/.rec` 当前组织绑定的配置/会话目录,并在未登录时快速提示运行 `rec login` / `recx login` 而不挂起后台探测。
  - 对话翻译:用自己的语言和 Agent 对话,Agent 的上下文里只有 Agent 语言。见下文「对话翻译」。

## 一次性设置

1. 把 `zh` 分支推到 fork,在 **Settings → General → Default branch** 里把它设为默认分支(定时任务只在默认分支上跑)。
2. fork 默认禁用 Actions:打开 **Actions** 页,点启用。
3. **Settings → Secrets and variables → Actions** 里添加:

   | 名称 | 必填 | 说明 |
   | --- | --- | --- |
   | `DEEPSEEK_API_KEY` | 是 | 建议单独建一个、只充少量余额的 key。合并冲突、挂入点修复、翻译都用它 |
   | `ZH_PUSH_TOKEN` | 是 | fine-grained token,只选本仓库,权限 **Contents: Read and write** + **Workflows: Read and write**。合并带进来的上游提交改过 workflow 文件,默认的 `GITHUB_TOKEN` 推不上去 |
   | `DEEPSEEK_PROTOCOL` | 否 | `anthropic`(默认,Anthropic Messages)或 `responses`(OpenAI Responses) |
   | `DEEPSEEK_BASE_URL` | 否 | `anthropic` 默认 `https://api.deepseek.com/anthropic`,请求 `<地址>/v1/messages`;`responses` 默认 `https://api.openai.com/v1`,请求 `<地址>/responses` |
   | `DEEPSEEK_MODEL` | 否 | 默认 `deepseek-chat` |
   | `DEEPSEEK_AGENT_MODEL` | 否 | 修复 Agent 用的模型,默认同 `DEEPSEEK_MODEL`。Agent 走 Anthropic 协议,`DEEPSEEK_PROTOCOL=responses` 时不启用 |
   | `ANDROID_KEYSTORE_BASE64` | 否 | APK 签名用的 keystore(base64)。不配就是调试签名 |
   | `ANDROID_KEYSTORE_PASSWORD` | 否 | keystore 密码 |
   | `ANDROID_KEY_ALIAS` | 否 | 密钥别名 |
   | `ANDROID_KEY_PASSWORD` | 否 | 密钥密码,不填则同 keystore 密码 |

   生成 keystore:`keytool -genkeypair -v -keystore release.keystore -alias t3code -keyalg RSA -keysize 2048 -validity 36500`,再 `base64 -w0 release.keystore` 填进 `ANDROID_KEYSTORE_BASE64`。**一旦用了就别换**,换签名后手机上只能卸载重装。

4. **Actions → 中文版构建 → Run workflow** 手动跑第一次。第一次要翻译全部约 6700 条文案,DeepSeek 费用大约几块钱人民币;以后每个新版本只翻译新增的文案。

## 安装

- **Windows**:从 Releases 下载 `T3-Code-<版本>-x64.exe`。安装包没有签名,SmartScreen 提示时选“仍要运行”。装好后桌面端的自动更新读的是本仓库的 Releases,不会被官方英文版覆盖。不包含 WSL 后端。
- **Android**:下载 `t3code-zh-<版本>-android-arm64.apk`。包名和官方版相同而签名不同,装过官方版要先卸载。想自动更新可以用 [Obtainium](https://github.com/ImranR98/Obtainium) 跟踪本仓库的 Releases。这个 APK 关掉了官方 OTA 热更新,否则官方推送会把界面换回英文。

## 日常

- **改翻译**:直接编辑 `zh/locales/zh-Hans.json` 提交。下一个版本自动生效;想立刻重建当前版本,手动运行流水线并勾选“Release 已存在时也重新构建”。不过同版本号的重建不会触发桌面端自动更新,要手动下载安装。
- **改中文化代码**:直接在 `zh` 分支上改、提交、推送。改上游文件时新增的行加 `// t3code-zh-overlay` 注释,合并冲突时 AI 靠它认出哪些是我们的改动。
- **合并上游**:`zh/merge-upstream.cjs` 合并标签。上游 workflow 文件直接丢弃;其他冲突按冲突块交给 DeepSeek,解决结果里不能有冲突标记,也不能少了我们这边带标记的行,否则重试三次后放弃合并、什么都不推。AI 解决过的文件列在合并提交的说明里,运行摘要和 bot 通知也会提醒,建议看一眼。删改冲突、二进制冲突、超大文件只能手动:本地 `git merge vX.Y.Z` 解决后推到 `zh`(记得把 `zh/UPSTREAM` 改成新标签),下一次定时任务就会构建。
- **失败重试**:定时任务不会在同一个提交上重复跑已经失败的构建;推一个新提交,或手动运行(bot 里 `/t3 构建`)才会再试。
- **翻译规则和术语表**:`zh/TRANSLATION_GUIDE.md`,它同时是发给 DeepSeek 的系统提示词。
- **挂入点丢失**:合并后 `zh/apply.cjs` 会检查每个挂入点的标记还在不在;丢了就按锚点补回,锚点也没了才让 DeepSeek 只新增带标记的行。用了 AI 修复时运行摘要里会有 diff。
- **上游改动弄坏覆盖层**:挂入点还缺,或覆盖层单测没过,流水线会让 Agent(Claude Code CLI + DeepSeek)读代码修 `zh/`,最多两次。改动只在 `apply.cjs` 和全部单测都通过、没碰单测文件、上游文件里只改了带标记的行时才保留,单独成一个提交,bot 通知会提醒检查。修不好时:缺的是对话翻译、Reclaude 这类挂入点就**降级发布**(界面照样汉化,这些功能本版不生效,通知和 Release 说明里列出来),缺的是构建配置挂入点就失败。降级的挂入点修好后推到 `zh`,发 `/t3 构建 重建`。
- **遥测**:构建时关掉上游发回的一切:产品分析(PostHog,`ingest.t3.codes`)、为此读取 `~/.codex/auth.json` 和 `~/.claude.json`、中继追踪(Axiom)、手机端崩溃报告。上游每次改动遥测相关的文件,Agent 都会先审查 diff、确认仍然全关才继续,所以几乎每个版本的通知里都会有「AI 修复了覆盖层」,建议看一眼它的 diff。修不好就**不发版**,不会降级。构建产物还会再检查一遍服务端没有遥测地址。
- **关掉 Git 定时 fetch**:应用内 设置 → 后台活动 → Git fetch 间隔 设为 0。不需要改代码。

## 对话翻译

输入框右下角的「译」按钮里可以开关当前会话的翻译,并配置翻译接口(设置保存在该会话所在的服务端,桌面端和浏览器共用):

- **接口**:自己提供一个模型接口,支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种协议。例如 DeepSeek:协议选 Chat Completions,地址 `https://api.deepseek.com/v1`,模型 `deepseek-chat`。API Key 只保存在服务端的 `<数据目录>/zh-translation/config.json`(明文),不会回传给界面。
- **回复**:Agent 回复完成并滚动到可见区域后翻译成「我的语言」显示,下方可切换原文。复制按钮复制的仍是原文。
- **计划卡片**:和回复一样显示译文并可切换原文。卡片上的复制、下载、保存到工作区导出的是当前显示的那一版,要原文就先切回原文。
- **提问卡片**:题头、题目、选项和说明显示译文,鼠标悬停看原文。选中的选项仍按原文交给 Agent;你自己输入的回答,以及审批、计划的反馈意见,会先译成「Agent 语言」。
- **发送**:开启「翻译我发送的消息」时,消息在交给 Agent 之前先译成「Agent 语言」;时间线里保留你写的原文,消息下方的「查看发送的译文」能看到 Agent 实际收到的内容。斜杠命令只翻译参数。翻译失败时按原文发送,不会丢消息。
- **语言检测**:服务端按文字的书写系统判断,不需要翻译的内容不会发给接口:正文已经大半是目标语言(比如 Agent 直接用中文回复)、完全不含源语言的文字(比如你直接用英文提问),或者只有代码和路径。中文、日文、韩文、俄文、阿拉伯文、泰文、希伯来文、希腊文、印地文可以这样识别;英语、法语这类同用拉丁字母的语言彼此分不出来,照常交给接口。设置里的「测试」不受检测影响。
- **手机端**:回复、计划卡片和提问卡片同样显示译文(提问卡片没有悬停,直接显示译文)。输入框里模型按钮旁的「译」只能开关当前会话的翻译,接口要在桌面端或浏览器里设置;手机上也没有「查看发送的译文」。
- **范围**:只翻译你在界面里亲手发的消息和插话;定时任务、Agent 之间的消息、访客消息不翻译。思考过程暂不翻译,已回答的提问在时间线里显示原文。
- 译文缓存在 `<数据目录>/zh-translation/cache.jsonl`,重开会话不重复计费。
- 构建时设 `T3CODE_TRANSLATION=0` 可以去掉这个功能。

## 安全

- 只有 `schedule` 和 `workflow_dispatch` 能触发,别人的 PR 拿不到 secrets。
- DeepSeek 密钥只交给 `prepare` 任务里本仓库自己的 `merge-upstream.cjs`、`repair.cjs`、`agent-repair.cjs` 和 `translate.cjs`。这个任务只做 git 合并、只 `npm ci --ignore-scripts` 装 `oxc-parser` 和 `magic-string`,不安装也不执行任何上游代码。
- 修复 Agent 是固定版本的 Claude Code CLI:只能读文件、改 `zh/` 和 `apps/`、跑 `node zh/apply.cjs`、`node --test "zh/*.test.cjs"`、`node zh/telemetry-surface.cjs` 和只读的 git 命令;环境变量里只有 DeepSeek 密钥。`ZH_PUSH_TOKEN` 不写进 `.git/config`,只在推送那一步用。
- 真正跑上游代码的构建任务拿不到密钥。
- 第三方 action 都固定到了 commit SHA。

## 本地调试

```sh
# 在 zh 分支的检出里
cd zh && npm ci && cd ..
node zh/apply.cjs              # 检查挂入点(已经都在时什么也不改)
node zh/extract.cjs --stats    # 列出词典缺的文案 → zh/.cache/missing.json
DEEPSEEK_API_KEY=... node zh/translate.cjs --limit 100
T3CODE_LOCALE=zh-Hans vp run build:desktop:bundle
node --test "zh/*.test.cjs"
```

不设 `T3CODE_LOCALE=zh-Hans` 时,UI 翻译插件什么也不做;设 `T3CODE_RECLAUDE=0` 可关闭 `rec` / `recx` 服务端兼容注入,设 `T3CODE_TRANSLATION=0` 可关闭对话翻译注入。
