# Third-party models

Runtime downloads use Hugging Face/upstream sources, not Subline releases. The Subline `models-v1` release does not exist yet. `SELF_HOSTED` is future opt-in configuration (enable `SELF_HOSTED_ENABLED` only after publishing verified assets).

Native downloaders verify size and SHA-256 where a pin exists in `SELF_HOSTED_PINS`. Hugging Face native URLs for pinned files use `HF_REVISIONS`; mirrored copies must be identical bytes. Web M2M100 retains main URLs for Transformers.js cache compatibility.

Unpinned: Hy-MT2 7B Q4_K_M (keeps its current upstream revision), and any future files without entries in the pin table. These remain downloadable without pin verification. M2M100 1.2B keeps the existing upstream release because no equivalent HF ONNX source is registered.

Each model remains under its original license. Model names, authors and sources are kept as required.

| Model | Mirrored assets | Original author / source | Converted for sherpa-onnx or ONNX by | License |
|---|---|---|---|---|
| SenseVoice Small (zh / en / ja / ko / yue) | `sense-voice-*` | FunAudioLLM, Alibaba — [FunAudioLLM/SenseVoiceSmall](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) | [k2-fsa / csukuangfj](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17) | [FunASR Model Open Source License v1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE) |
| Paraformer zh | `paraformer-zh-*` | FunASR, Alibaba — [modelscope/FunASR](https://github.com/modelscope/FunASR) | [k2-fsa / csukuangfj](https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09) | [FunASR Model Open Source License v1.1](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE) |
| ReazonSpeech k2 v2 (ja) | `zipformer-ja-reazonspeech-*` | Reazon Human Interaction Lab — [reazon-research/reazonspeech-k2-v2](https://huggingface.co/reazon-research/reazonspeech-k2-v2) | [csukuangfj/reazonspeech-k2-v2](https://huggingface.co/csukuangfj/reazonspeech-k2-v2) | Apache-2.0 |
| Parakeet TDT 0.6B v2 (en) | `parakeet-tdt-0.6b-v2-en-*` | NVIDIA — [nvidia/parakeet-tdt-0.6b-v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) | [k2-fsa / csukuangfj](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8) (int8) | CC-BY-4.0 |
| Silero VAD | `silero_vad.onnx` | Silero Team — [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | — | MIT |
| M2M100 418M | `m2m100_418M-*` | Meta AI — [facebook/m2m100_418M](https://huggingface.co/facebook/m2m100_418M) | [Xenova/m2m100_418M](https://huggingface.co/Xenova/m2m100_418M) (quantized ONNX) | MIT |
| M2M100 1.2B | `m2m100_1.2B-*` | Meta AI — [facebook/m2m100_1.2B](https://huggingface.co/facebook/m2m100_1.2B) | Upstream [baijunjie/realtime-translator](https://github.com/baijunjie/realtime-translator) (optimum export, merged decoder, q8) | MIT |
| Hy-MT2 7B Q4_K_M (not mirrored) | — | Tencent — [tencent/Hy-MT2-7B-GGUF](https://huggingface.co/tencent/Hy-MT2-7B-GGUF) | — | Apache-2.0 |

The FunASR model license permits use, copying, modification and sharing when the source, author and model names are credited. It disclaims liability and terminates on violation; see the linked text for its full terms. CC-BY-4.0 requires attribution to NVIDIA as the original author. These assets were first published on the upstream `baijunjie/realtime-translator` `models-v1` release. The optional mirror script can copy identical files to a future Subline release; no mirror publication is implied.
