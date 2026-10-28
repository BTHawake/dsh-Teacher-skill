# dsh-Teacher-skill

把 [teacher.skill](https://github.com/BTHawake/Teacher_skill) 的 HTML 课件挂到 **DSH 自己的 Web 服务器**下，而不是再开一个 `8765` 端口。

安装后，DSH 的地址后面直接加 `/teacher/` 就能打开课件；答题卡也同源提交，远程访问 DSH 时不需要额外端口转发。

> 这个仓库只是 **DSH host 插件**。teacher.skill 不在本仓库内；skill 会先探测 `/teacher/api/health`，再决定是否使用/安装本插件。

## 路由

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/teacher/api/health` | 健康检查，skill 用来判断插件是否已挂载 |
| GET | `/teacher/api/answers/latest?workspace=...&course=...` | 读取最近一次答题卡提交 |
| POST | `/teacher/api/answers` | 写入 `answers/latest.json` |
| GET | `/teacher/<workspace>/<course>/...` | 提供课件静态文件 |

静态文件的映射：

```
<registered workspace root>/讲义/<course>/index.html
  → /teacher/<workspace>/<course>/index.html
```

例如注册：

```json
{"workspaces":{"操作系统":"D:\\wake\\HarnessWorkspace\\操作系统"}}
```

则：

```
D:\wake\HarnessWorkspace\操作系统\讲义\操作系统\index.html
  → /teacher/操作系统/操作系统/index.html
```

本机调试可以直接访问 `http://127.0.0.1:3080/teacher/...`；**远程请发根相对链接**，不要发 `127.0.0.1` 绝对地址。

## 安装

前置：DSH Web 能正常启动，Node.js 22+。

```powershell
git clone git@github.com:BTHawake/dsh-Teacher-skill.git
cd dsh-Teacher-skill
dsh plugin --profile web add "link:$PWD"
```

或者不用 clone，直接把本目录加入 profile（换成你的实际路径）：

```powershell
dsh plugin --profile web add 'link:<plugin-dir>'
```

添加后**重启 `dsh web`**，刷新 DSH 页面。验证：

```bash
curl http://127.0.0.1:3080/teacher/api/health
# {"ok":true,"plugin":"dsh-teacher-skill","version":"0.2.0",...}
```

> `dsh plugin` 的 profile 操作可能随 DSH 版本变化，以当前 `dsh plugin --help` 为准。

## 配置

`cordis.patch.yml` 默认不写死任何机器路径：

```yaml
- id: teacher-course
  name: dsh-teacher-skill
  config:
    enabled: true
    workspaceRoot: ''   # 可选，仅旧版单根模式
    registry: ''        # 默认 ~/.dsh/teacher-workspaces.json
    token: ''
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `workspaceRoot` | 空 | 旧版单根父目录；新安装推荐留空，用注册表 |
| `registry` | `~/.dsh/teacher-workspaces.json` | AI 注册 workspace 根目录的文件 |
| `token` | 空 | 非空时，答题 API 需要 `x-teacher-token` |
| `enabled` | `true` | 关闭插件路由 |
| `maxBodyBytes` | 1 MiB | 答题 JSON 上限 |

### AI 注册 workspace

教师 skill 的 AI 应先 `pwd` 判断当前工作区，然后注册：

```bash
python scripts/dsh_register.py --workspace-root "$PWD" --json
```

写入：

```json
{
  "workspaces": {
    "操作系统": "D:\\wake\\HarnessWorkspace\\操作系统"
  }
}
```

插件只服务注册过的根目录；没注册的 `/teacher/<workspace>/...` 返回 503，不会拿 cwd 乱猜。

## 和 teacher.skill 配合

teacher.skill 的 AI 应优先探测：

```bash
python scripts/dsh_host.py --json
```

如果返回 `mode: "dsh-plugin"`，生成课件时加：

```bash
python scripts/lesson_html.py build --course "计算机组成原理" \
  --file "讲义/计算机组成原理/unit-04.md" \
  --state "teachers/计算机组成原理/learning-state.json" \
  --api-path "/teacher/api/answers" \
  --workspace "TeacherSkillEditor"
```

聊天里发可直接打开的**根相对链接**：

```
/teacher/TeacherSkillEditor/计算机组成原理/index.html
```

`http://127.0.0.1:3080/...` 只对本机有效；远程请在 skill 里用 `--public-base` 生成 `public_url`，不要手拼 `127.0.0.1`。

如果探测不到插件，skill 可以：

1. 提示安装本插件（需要重启 DSH）
2. 或者回退到 `course_server.py`（独立端口）
3. 或者只导出 HTML，让用户复制答案回聊天

## 安全

- 默认没有登录页，依赖 **DSH 自身的访问控制/隧道**。如果 DSH 暴露在公网，务必设置 `token`，并在反向代理层加认证。
- 静态路由只允许 `<注册的 workspace root>/讲义/<course>/` 下的文件；`answers/` 目录不通过静态路由暴露。
- `token` 非空时，答题卡通过 `x-teacher-token` 发送；页面本身仍受 DSH 访问控制。
- 不要在公开网络上无鉴权地暴露 `/teacher/api/answers`。

## 卸载

```powershell
dsh plugin --profile web remove dsh-teacher-skill
```

然后重启 `dsh web`。

## 开发

```bash
node --check index.js
node --test
```

测试覆盖：路径穿越、静态文件、答题写入、路由表。

## License

MIT
