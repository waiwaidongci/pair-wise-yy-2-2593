# 赛季报名核验台

在赛鸽档案、疫苗记录、转让记录、归巢成绩四类数据之上的赛季报名核验台。

运行：

```bash
npm start        # http://localhost:3024
npm test         # 端到端规则验证（使用临时数据文件，不影响 data/pigeons.json）
```

数据存于 `data/pigeons.json`（可用环境变量 `PIGEON_DB` 指定其他路径；旧格式启动时自动迁移：补疫苗到期日、转让结清标记、成绩归属和赛事/名额/冲突表）。

## 核验规则

1. **每只鸽每场比赛只留一个待确认名额**。状态：待确认 → 已确认；更正后可变为已失效（保留留痕，可重新报名）。
2. **两人同时提交，先到者占用，后到者落冲突**。写操作经进程内队列串行化；冲突保留后到提交的现场单、提交人和原始内容，页面「冲突记录」列出。
3. **疫苗到期或转让未结清不让报名**（422，不落名额）：
   - 疫苗按接种日/到期日与比赛日比对，默认有效期 180 天；
   - 比赛已开赛同样拒收；
   - 提交人与现鸽主不一致也拒收。
4. **已开赛成绩仍归原鸽主**：归巢成绩录入时按转让链以归巢日重建原鸽主并固化，事后档案再转让不改变已录成绩的归属。
5. **写盘失败凭现场单重试，不重复生成名额**：报名返回/保留现场单号 `ticket`，同一单号重试是幂等的——名额单重试返回同一名额（`retry:true`），冲突单重试返回同一冲突。页面勾选「模拟本次写盘失败」可演练（请求头 `X-Simulate-Write-Fail: 1`）。
6. **档案或疫苗（及转让）更正后，未开赛的待确认名额失效**，需在页面重新核验/报名；已开赛名额不受影响。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/registrations` | 报名提交 `{ringNo, eventId, applicant, ticket?}`；201 占名额，409 留冲突，422 资格不过，500 写盘失败 |
| POST | `/api/registrations/:id/confirm` | 确认待确认名额（确认前再核验一次） |
| POST | `/api/registrations/:id/recheck` | 按最新档案重算名额资格 |
| GET | `/api/console` | 页面聚合数据：鸽只、赛事、名额、冲突 |
| GET | `/api/evaluate/:ringNo/:eventId` | 单鸽单场资格核验 |
| PATCH | `/api/pigeons/:ringNo/profile` | 档案更正（未开赛名额失效） |
| POST | `/api/pigeons/:ringNo/vaccines` | 疫苗补录/更正 `{date, expiresOn, name}`（未开赛名额失效） |
| POST | `/api/pigeons/:ringNo/transfers` | 登记转让，默认**未结清**（未开赛名额失效） |
| POST | `/api/pigeons/:ringNo/transfers/:id/settle` | 转让结清（未开赛名额重算） |
| POST | `/api/pigeons/:ringNo/races` | 归巢成绩，归属按归巢日原鸽主固化 |
