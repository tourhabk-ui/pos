Сгенерировать изображение с помощью Google Gemini Imagen.

## Использование
`/image-generator <описание на любом языке>`

Примеры:
- `/image-generator вулкан Камчатки на закате, фотореализм`
- `/image-generator медведь у реки, акварель, мягкие тона`
- `/image-generator туристы на фоне Долины Гейзеров, aerial shot`

## Как работает

**Шаг 1: Проверить наличие GEMINI_API_KEY**

```bash
echo "${GEMINI_API_KEY:0:8}..."
```

Если переменная не задана — сообщи пользователю:
> Нужен GEMINI_API_KEY. Получи бесплатно на https://aistudio.google.com/ и добавь в `.env.local`:
> `GEMINI_API_KEY=your_key_here`
> Затем перезапусти сессию.

**Шаг 2: Составить JSON-запрос (записать в файл)**

Prompt обязательно на английском для лучшего результата — переведи если нужно.

```bash
cat > /tmp/imagen_request.json << 'REQEOF'
{
  "instances": [
    {
      "prompt": "<ENGLISH_PROMPT_HERE>"
    }
  ],
  "parameters": {
    "sampleCount": 1,
    "aspectRatio": "16:9",
    "safetyFilterLevel": "block_few",
    "personGeneration": "allow_adult"
  }
}
REQEOF
```

**Шаг 3: Вызвать Imagen API**

```bash
curl -s -X POST \
  "https://us-central1-aiplatform.googleapis.com/v1/projects/generativelanguage/locations/us-central1/publishers/google/models/imagen-3.0-generate-001:predict" \
  -H "Authorization: Bearer $(gcloud auth print-access-token 2>/dev/null || echo $GEMINI_API_KEY)" \
  -H "Content-Type: application/json" \
  -d @/tmp/imagen_request.json \
  -o /tmp/imagen_response.json
```

Альтернатива через Gemini REST API (если нет gcloud):

```bash
curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict?key=${GEMINI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d @/tmp/imagen_request.json \
  -o /tmp/imagen_response.json
```

**Шаг 4: Извлечь и сохранить изображение**

```bash
# Извлечь base64 и декодировать в PNG
python3 -c "
import json, base64, sys
with open('/tmp/imagen_response.json') as f:
    data = json.load(f)
# Проверить на ошибки
if 'error' in data:
    print('ERROR:', data['error'].get('message', data['error']), file=sys.stderr)
    sys.exit(1)
predictions = data.get('predictions', [])
if not predictions:
    print('ERROR: no predictions in response', file=sys.stderr)
    print(json.dumps(data, indent=2), file=sys.stderr)
    sys.exit(1)
img_b64 = predictions[0].get('bytesBase64Encoded', '')
if not img_b64:
    print('ERROR: no image data', file=sys.stderr)
    sys.exit(1)
out_path = '/tmp/imagen_output.png'
with open(out_path, 'wb') as out:
    out.write(base64.b64decode(img_b64))
print(out_path)
"
```

**Шаг 5: Показать результат**

Используй Read tool чтобы показать изображение пользователю:
- Read `/tmp/imagen_output.png`

Затем предложи:
- Сохранить в `public/images/` репозитория
- Уточнить промпт и перегенерировать
- Изменить соотношение сторон (1:1, 4:3, 16:9, 9:16, 21:9)

## Параметры

| Параметр | Значения | По умолчанию |
|----------|---------|--------------|
| `aspectRatio` | `"1:1"`, `"4:3"`, `"3:4"`, `"16:9"`, `"9:16"` | `"16:9"` |
| `sampleCount` | 1–4 | `1` |
| `safetyFilterLevel` | `"block_few"`, `"block_some"`, `"block_most"` | `"block_few"` |

## Если API не работает

Попробуй альтернативный endpoint через Gemini 2.0 Flash с image output:

```bash
cat > /tmp/gemini_img_request.json << 'REQEOF'
{
  "contents": [{"parts": [{"text": "<PROMPT>"}]}],
  "generationConfig": {
    "responseModalities": ["IMAGE", "TEXT"],
    "responseMimeType": "image/png"
  }
}
REQEOF

curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${GEMINI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d @/tmp/gemini_img_request.json \
  -o /tmp/gemini_img_response.json
```

Затем извлеки `candidates[0].content.parts[0].inlineData.data` (base64 PNG).
