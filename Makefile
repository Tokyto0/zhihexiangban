.PHONY: dev db-migrate seed test test-e2e eval license-check clean-demo

dev:
	python backend/run.py

db-migrate:
	@echo "MVP 使用本地 JSON store；PostgreSQL/pgvector 迁移接口预留。"

seed:
	python scripts/seed_demo.py

test:
	python scripts/test_mvp.py

test-e2e:
	@echo "请先启动 API 与前端，再按 README 的浏览器验收清单执行。"

eval:
	python scripts/eval_mvp.py

license-check:
	@echo "已使用依赖与数据资源见 THIRD_PARTY_NOTICES.md"

clean-demo:
	python scripts/clean_demo.py
