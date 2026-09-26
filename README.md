# TikTok 热点看板

每天自动抓取一次美国 TikTok 热门话题（前 20 个），在网页看板中查看、生成选题、规划发布。

- 数据：TikTok Creative Center，通过 Apify 的 `clockworks/tiktok-trends-scraper` 抓取
- 定时任务：GitHub Actions（每天 14:00 UTC）
- 网页：GitHub Pages
- 费用：全部使用免费额度（见下方「费用」）

## 设置步骤（约 10 分钟）

1. **注册 Apify**：<https://apify.com>，选 Free 计划，**不要绑定信用卡**。
2. **复制 Apify API Token**：Apify 控制台 → Settings → API & Integrations → Personal API tokens。
3. **新建 GitHub 仓库**（Public），把本文件夹里的全部文件上传进去。
4. **保存 Token**：仓库 → Settings → Secrets and variables → Actions → New repository secret
   - Name：`APIFY_TOKEN`
   - Secret：粘贴第 2 步的 Token
5. **允许写入**：仓库 → Settings → Actions → General → Workflow permissions → 选 *Read and write permissions* → Save。
6. **开启网页**：仓库 → Settings → Pages → Source 选 *Deploy from a branch*，Branch 选 `main` / `(root)` → Save。
7. **首次抓取**：仓库 → Actions → *Update TikTok trends* → *Run workflow*。约 1–3 分钟后完成。
8. 打开 `https://<你的用户名>.github.io/<仓库名>/` 即可看到看板，之后每天自动更新。

## 费用

| 项目 | 费用 |
|---|---|
| GitHub Actions / Pages（公开仓库） | 免费 |
| Apify Free 计划 | 每月 $5 免费额度，未绑卡时用完只会暂停，不会扣费 |
| 每天 20 条 × 30 天 ≈ 600 条 | 约 $1–3，在免费额度内 |

脚本每次运行前会查询本月 Apify 用量，超过额度的 80% 就自动跳过当天，看板显示上一次的数据并提示原因。

## 修改设置

在 `.github/workflows/update-trends.yml` 中：

- `COUNTRY: US` 改成其他国家代码（如 `GB`、`JP`）
- `LIMIT: '20'` 是每天抓取条数；调高会更快用完免费额度
- `cron: '0 14 * * *'` 是每天运行时间（UTC）

## 说明

- Viral Potential、IP Fit、Reuse Leverage 是脚本按规则计算的内部评分，不是 TikTok 官方数据。
- 第一天所有话题状态为 New；从第二天起根据排名变化显示 Rising / Cooling / Stable / Breakout。
- 抓取失败时，看板保留上一次成功的数据，并显示失败原因与数据时间。
- 抓取由 Apify 完成，本仓库不保存任何 TikTok 账号信息；Token 只存在 GitHub Secrets 中。
