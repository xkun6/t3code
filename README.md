# T3 Code 中文版流水线

这个分支只放构建中文版需要的东西,不含 T3 Code 源码:

- `.github/workflows/zh-release.yml`:每小时检查上游 [pingdotgg/t3code](https://github.com/pingdotgg/t3code) 的最新稳定版(`vX.Y.Z` 标签),本仓库还没发布过就自动翻译、构建、发布。
- `zh/`:构建时的中文化与增强覆盖层。不改上游业务源码,只在构建/入口配置里各插一两行(Web、桌面端、服务端的 Vite 配置,服务端开发入口与移动端的 Metro 配置):
  - 构建时把界面里的英文字符串替换成 `zh/locales/zh-Hans.json` 里的翻译。
  - 服务端兼容 Reclaude(`rec` / `reclaude`)与 Recodex(`recx` / `recodex`)封装 CLI:在 **设置 → 提供商 → Claude / Codex → 二进制路径** 填入 `rec`(`rec.exe`)或 `recx`(`recx.exe`)即可直接使用,自动透传 `cli` 子命令与前置 `--org <id>` 参数、对齐 `~/.rec` 当前组织绑定的配置/会话目录,并在未登录时快速提示运行 `rec login` / `recx login` 而不挂起后台探测。
  - 对话翻译:用自己的语言和 Agent 对话,Agent 的上下文里只有 Agent 语言。见下文「对话翻译」。

## 一次性设置

1. 把本分支推到 fork,在 **Settings → General → Default branch** 里把它设为默认分支(定时任务只在默认分支上跑)。
2. fork 默认禁用 Actions:打开 **Actions** 页,点启用。
3. **Settings → Secrets and variables → Actions** 里添加:

   | 名称 | 必填 | 说明 |
   | --- | --- | --- |
   | `DEEPSEEK_API_KEY` | 是 | 建议单独建一个、只充少量余额的 key |
   | `DEEPSEEK_PROTOCOL` | 否 | `anthropic`(默认,Anthropic Messages)或 `responses`(OpenAI Responses) |
   | `DEEPSEEK_BASE_URL` | 否 | `anthropic` 默认 `https://api.deepseek.com/anthropic`,请求 `<地址>/v1/messages`;`responses` 默认 `https://api.openai.com/v1`,请求 `<地址>/responses` |
   | `DEEPSEEK_MODEL` | 否 | 默认 `deepseek-chat` |
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
- **翻译规则和术语表**:`zh/TRANSLATION_GUIDE.md`,它同时是发给 DeepSeek 的系统提示词。
- **上游改了构建配置**:注入锚点失效时,流水线会让 DeepSeek 改那个配置文件。改法只能新增带 `t3code-zh-overlay` 标记的行,删改任何原有行都会被拒绝。用了 AI 修复时运行摘要里会有 diff,建议看一眼。
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
- DeepSeek 密钥只交给 `prepare` 任务里本仓库自己的 `repair.cjs` 和 `translate.cjs`。这个任务只 `npm ci --ignore-scripts` 装 `oxc-parser` 和 `magic-string`,不安装也不执行任何上游代码。真正跑上游代码的构建任务拿不到密钥。
- 第三方 action 都固定到了 commit SHA。

## 本地调试

```sh
# 在上游源码根目录,把本分支的 zh/ 复制进去
cd zh && npm ci && cd ..
node zh/apply.cjs              # 注入构建配置(幂等)
node zh/extract.cjs --stats    # 列出词典缺的文案 → zh/.cache/missing.json
DEEPSEEK_API_KEY=... node zh/translate.cjs --limit 100
T3CODE_LOCALE=zh-Hans vp run build:desktop:bundle
node --test zh/localize.test.cjs zh/reclaude.test.cjs zh/translation.test.cjs
```

不设 `T3CODE_LOCALE=zh-Hans` 时,UI 翻译插件什么也不做;设 `T3CODE_RECLAUDE=0` 可关闭 `rec` / `recx` 服务端兼容注入,设 `T3CODE_TRANSLATION=0` 可关闭对话翻译注入。
