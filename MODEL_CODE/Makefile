.PHONY: install test train evaluate reproduce clean submission

install:
	pip install -r requirements.txt

test:
	python -m pytest tests/ -v

train:
	python train_gpu.py

evaluate:
	python evaluate_gpu.py

reproduce: install train evaluate
	@echo "Reproduction complete. Results in data/"

clean:
	rm -f data/model_weights.pt data/gpu_results.json data/eval_results.json

submission:
	@echo "Packaging checklist: see SUBMISSION.md"
	@git rev-parse --short HEAD 2>/dev/null || true
