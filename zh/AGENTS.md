# zh fork 规则

`zh` 分支 = 上游 pingdotgg/t3code 的稳定版 + 中文化提交。上游每次发版,`.github/workflows/zh-release.yml` 都会自动把新标签合并进来(冲突交给 AI 按块解决),再翻译、构建、发布。下面的规则都是为了让这种自动合并不出错。上游 `AGENTS.md` 里的代码规范照样适用。

## 结构

- `zh/`:中文化覆盖层(界面翻译、Reclaude/Recodex 兼容、对话翻译)。只有我们改,合并永远不会在这里冲突。
- 上游文件里只有少量挂入点。清单以 `zh/apply.cjs` 的 `EDITS` / `NATIVE_EDITS` 为准。
- `zh/UPSTREAM`:已合并的上游标签,流水线靠它判断要不要合并。
- `zh/merge-upstream.cjs`:合并上游标签,并让 AI 解决冲突。
- `zh/agent-repair.cjs`:合并后挂入点或覆盖层单测失败时,让流水线里的 Agent(Claude Code CLI + DeepSeek)修 `zh/`。过了 `apply.cjs` 和全部单测才保留;对话翻译、Reclaude 这类挂入点仍缺就降级发布,构建配置挂入点仍缺就失败。它不许改 `zh/*.test.cjs`:单测是验收标准,改单测要人来。
- 使用说明和 secrets 清单在 `zh/README.md`,翻译规则在 `zh/TRANSLATION_GUIDE.md`(它同时是发给 DeepSeek 的提示词)。

## 改 `zh/` 以外的文件(上游文件)

- 能在 `zh/` 里做的就别改上游文件:优先用构建时变换(Vite/Metro 插件),参考 `zh/reclaude-transform.cjs`、`zh/translation-transform.cjs`。
- 非改不可时,只新增行,尽量不改、不删上游原有的行。**我们新增或改动的每一行都要带标记 `t3code-zh-overlay`**:代码用 `// t3code-zh-overlay`,Markdown 用 `<!-- t3code-zh-overlay -->`。合并冲突时,AI 给出的解决方案如果丢了我方带标记的行,`merge-upstream.cjs` 会拒绝它;没带标记的改动会被当成上游代码,可能被覆盖掉。
- 新增一个挂入点时,同时在 `zh/apply.cjs` 里加一条对应的 `EDITS`(锚点 + `goal`)。这样合并后挂入点丢了能自动补回,锚点也没了还能让 AI 修复。如果能在构建产物里验证,再在 workflow 的「校验覆盖层已打包」步骤里加一条 grep。
- 不要格式化、重排或批量改写上游文件,不要动根目录的 `package.json` / `pnpm-lock.yaml`。覆盖层自己的依赖放在 `zh/package.json`。
- 根目录 `README.md`、`AGENTS.md` 保持上游原样,只允许有一行带标记的指引。

## 不要随手改

- `zh/UPSTREAM`:只由合并写入。只有你自己手动合并了上游标签,才把它改成新标签。
- `.github/workflows/`:只能放 `zh-*.yml`,其他名字的文件在下次合并时会被当成上游 workflow 删掉。不要恢复上游的 workflow。`.github/actions/` 是上游的,构建要用 `setup-ci-deps`,不要改。
- `zh/locales/zh-Hans.json`:流水线翻译后会自动提交。手改可以,但键要保持排序(和 `translate.cjs` 的写法一致)。

## 和 dsh-bot 插件的接口

插件仓库是 `dsh-t3code`(`watcher.py`),它通过 GitHub API 读这个流水线。下面这些改了,要同步改插件:

- workflow 文件名 `zh-release.yml`、分支名 `zh`(插件配置里能改)。
- `prepare` 任务名必须以「合并上游」开头,并带上 `vX.Y.Z`:插件从任务名里读版本号。
- 步骤名「AI 解决了合并冲突」「AI 修复了构建配置」「AI 修复了覆盖层」,以及以「降级发布」开头的步骤(名字里带缺的挂入点):插件靠它们在通知里提醒你检查。
- `workflow_dispatch` 的输入 `tag` / `rebuild`。
- Release 的标签就是上游标签 `vX.Y.Z`:插件用它拼 Release 链接,桌面端自动更新也读这里。

## 安全

- DeepSeek 密钥和 `ZH_PUSH_TOKEN` 只给 `prepare` 任务。这个任务只能跑 git 和 `zh/` 里我们自己的脚本(`npm ci --ignore-scripts` 也只在 `zh/` 里执行),不许安装或执行上游代码。唯一的例外是固定版本的 Claude Code CLI(修复 Agent):它的工具和命令有白名单(见 `agent-repair.cjs` 的 `ALLOWED_TOOLS`),环境变量里只有 DeepSeek 密钥。`ZH_PUSH_TOKEN` 不写进 `.git/config`,只在推送那一步用。构建任务不许拿到任何密钥。
- 新加的第三方 action 要固定到 commit SHA。

## 验证

```sh
cd zh && npm ci --ignore-scripts && cd ..
node zh/apply.cjs        # 应该全部输出 already applied,git status 没有改动
node --test "zh/*.test.cjs"
python -c "import yaml;yaml.safe_load(open('.github/workflows/zh-release.yml',encoding='utf-8'))"
```

推送到 `zh` 不会自动出包:上游出新版本时会一起发布。想立刻出包,在 bot 里发 `/t3 构建 重建`,或手动运行 workflow 并勾选 rebuild。同一个版本号重建,桌面端不会自动更新。
