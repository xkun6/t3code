# T3 Code 中文版流水线

这个分支只放构建中文版需要的东西,不含 T3 Code 源码:

- `.github/workflows/zh-release.yml`:每小时检查上游 [pingdotgg/t3code](https://github.com/pingdotgg/t3code) 的最新稳定版(`vX.Y.Z` 标签),本仓库还没发布过就自动翻译、构建、发布。
- `zh/`:构建时的中文化覆盖层。不改上游源码,只在三个构建配置里各插一两行(Web 和桌面端的 Vite 配置、移动端的 Metro 配置),构建时把界面里的英文字符串替换成 `zh/locales/zh-Hans.json` 里的翻译。

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
node --test zh/localize.test.cjs
```

不设 `T3CODE_LOCALE=zh-Hans` 时,注入的插件什么也不做。
