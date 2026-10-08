# TIPA FAQ Processor

Локальный Node.js + TypeScript pipeline для автоматической обработки текстовых расшифровок видео проекта **TIPA HOUSE**.

Проект превращает расшифровки видео в структурированную единую базу FAQ: извлекает вопросы и ответы с помощью AI, определяет разделы и теги, объединяет похожие вопросы из разных источников и проверяет целостность итоговых данных.

---

## 📋 Возможности

* обработка текстовых расшифровок видео;
* извлечение вопросов и ответов с помощью AI;
* работа с локальной моделью через Ollama;
* возможность использования OpenAI-совместимых API;
* автоматическое определение разделов;
* автоматическое формирование и накопление тегов;
* объединение похожих вопросов;
* сохранение исходных формулировок вопросов;
* сохранение файлов-источников;
* отслеживание уже обработанных расшифровок;
* валидация итоговой FAQ-базы;
* dry-run для безопасного тестирования;
* TypeScript type checking;
* автоматическое форматирование и linting через Biome.

---

## 🏗 Структура проекта

```text
tipa-faq/
│
├── src/
│   ├── process.ts       # Основной pipeline обработки расшифровок
│   ├── ai.ts            # Работа с AI / OpenAI-compatible API
│   ├── merge.ts         # Объединение и дедупликация FAQ
│   ├── validate.ts      # Проверка итоговой FAQ-базы
│   ├── io.ts            # Чтение и запись JSON-файлов
│   └── types.ts         # Общие TypeScript-типы
│
├── prompts/
│   └── extract-faq.md   # Промпт для извлечения FAQ
│
├── data/
│   ├── faq.json         # Основная база FAQ
│   ├── sections.json    # Разделы проекта
│   ├── tags.json        # Теги проекта
│   └── processed.json   # Обработанные расшифровки
│
├── transcripts/
│   └── *.txt            # Исходные расшифровки видео
│
├── .vscode/
│   └── settings.json    # Настройки VS Code
│
├── .editorconfig        # Базовые настройки редактора
├── biome.json           # Formatter + linter
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🚀 Установка

Установить зависимости:

```bash
npm install
```

Перед первым запуском необходимо настроить `.env`.

---

## ⚙️ Конфигурация AI

Проект использует OpenAI-compatible API.

Поддерживаются:

* OpenAI;
* Ollama;
* OpenRouter;
* другие совместимые API.

### Ollama

Для локальной модели пример конфигурации:

```env
OPENAI_BASE_URL=http://localhost:11434/v1
OPENAI_API_KEY=ollama
OPENAI_MODEL=qwen3.5:4b
```

Название модели зависит от установленной модели Ollama.

### OpenAI

```env
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=your-model
```

### OpenRouter

```env
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=your-model
```

Файл `.env` не должен попадать в Git.

---

## ▶️ Запуск pipeline

### Основная обработка

```bash
npm run process
```

Pipeline:

```text
transcripts/*.txt
        ↓
   AI extraction
        ↓
 вопросы + ответы
        ↓
разделы + теги
        ↓
    merge FAQ
        ↓
   data/faq.json
```

Обрабатываются новые или изменённые расшифровки.

Уже обработанные файлы отслеживаются в:

```text
data/processed.json
```

---

## 🧪 Dry-run

Для тестирования без изменения итоговых данных:

```bash
npm run process:dry
```

Dry-run позволяет проверить, что произойдёт при обработке файлов, не изменяя основную FAQ-базу.

---

## ✅ Валидация

После обработки можно проверить итоговые данные:

```bash
npm run validate
```

Проверяются, в частности:

* корректность структуры FAQ;
* наличие обязательных полей;
* корректность `id`;
* наличие `file` у исходных вопросов;
* корректность разделов;
* корректность тегов;
* структуру источников.

Рекомендуемый цикл:

```bash
npm run process
npm run validate
```

---

## 🔧 Разработка

### Проверка TypeScript

```bash
npm run typecheck
```

### Проверка Biome

```bash
npm run check
```

### Автоматическое исправление Biome

```bash
npm run check:write
```

### Форматирование

```bash
npm run format
```

### Проверка форматирования без изменений

```bash
npm run format:check
```

---

## 🧹 Форматирование кода

Проект использует **Biome** вместо отдельной связки ESLint + Prettier.

Biome отвечает за:

* форматирование;
* linting;
* проверку качества TypeScript-кода.

В VS Code включено форматирование при сохранении.

Базовые настройки редактора находятся в:

```text
.editorconfig
```

Конфигурация Biome:

```text
biome.json
```

---

## 📊 Структура FAQ

Основная база находится в:

```text
data/faq.json
```

Один FAQ item имеет следующую структуру:

```json
{
  "id": "kak-pravilno-uteplit-fundament",
  "question": "Как правильно утеплить фундамент?",
  "answer": "Ответ на вопрос...",
  "sourceQuestions": [
    {
      "file": "video-001.txt",
      "question": "Чем лучше утеплять фундамент?"
    },
    {
      "file": "video-015.txt",
      "question": "Нужно ли утеплять фундамент снаружи?"
    }
  ],
  "sections": [
    "foundation-soils",
    "thermal-insulation"
  ],
  "tags": [
    "фундамент",
    "утепление"
  ],
  "sources": [
    {
      "file": "video-001.txt",
      "title": "Строительство фундамента"
    }
  ],
  "updatedAt": "2026-10-08T12:00:00.000Z"
}
```

### `sourceQuestions`

`sourceQuestions` хранит исходные формулировки вопросов, из которых был сформирован единый FAQ.

Это позволяет не терять связь между объединённым вопросом и исходными расшифровками.

Например:

```json
"sourceQuestions": [
  {
    "file": "video-001.txt",
    "question": "Чем лучше утеплять фундамент?"
  },
  {
    "file": "video-015.txt",
    "question": "Нужно ли утеплять фундамент снаружи?"
  }
]
```

---

## 🗂 Разделы

Разделы хранятся в:

```text
data/sections.json
```

Текущая структура разделов включает:

* Фундамент и грунты
* Ограждающие конструкции
* Армирование
* Теплоизоляция
* Полы и тёплый пол
* Кровля и стропила
* Окна и двери
* Внутренняя отделка
* Наружная отделка
* Печи, дымоходы и пожарная безопасность
* Отопление
* Водоснабжение
* Канализация
* Электрика
* Вентиляция
* Зимняя эксплуатация
* Инженерное мышление

Идентификаторы разделов используются в JSON:

```text
foundation-soils
building-envelope
reinforcement
thermal-insulation
floors-underfloor-heating
roof-rafers
windows-doors
interior-finishing
exterior-finishing
stoves-chimneys-fire-safety
heating
water-supply
sewerage
electrical
ventilation
winter-operation
engineering-thinking
```

---

## 🏷 Теги

Теги хранятся в:

```text
data/tags.json
```

Новые теги, обнаруженные при обработке, автоматически добавляются в список.

Перед сохранением список сортируется.

---

## 🔄 Объединение похожих вопросов

`merge.ts` объединяет FAQ-вопросы, которые относятся к одной теме.

Используется текстовая нормализация и сравнение токенов.

Пример:

```text
Как правильно утеплить фундамент?

Чем лучше утеплять фундамент?

Нужно ли утеплять фундамент снаружи?
```

могут быть объединены в один FAQ item.

При объединении:

* сохраняется основной вопрос;
* добавляются исходные формулировки;
* объединяются разделы;
* объединяются теги;
* добавляются новые источники;
* дополнительные ответы добавляются к существующему ответу.

---

## 📁 Исходные расшифровки

Расшифровки помещаются в:

```text
transcripts/
```

Например:

```text
transcripts/
├── video-001.txt
├── video-002.txt
└── video-003.txt
```

После запуска:

```bash
npm run process
```

pipeline определяет, какие файлы уже были обработаны.

---

## 🔐 Безопасность

Не добавлять в Git:

```text
.env
data/faq.json
data/backups/
```

API-ключи должны храниться только в `.env`.

Пример `.gitignore`:

```gitignore
node_modules/
.env
data/faq.json
data/backups/
```

---

## 🧰 Рекомендуемый рабочий цикл

Перед обработкой:

```bash
npm run typecheck
npm run check
```

Тестовый запуск:

```bash
npm run process:dry
```

Реальная обработка:

```bash
npm run process
```

Проверка результата:

```bash
npm run validate
```

Итого:

```text
1. Добавить новую расшифровку
          ↓
2. npm run process:dry
          ↓
3. Проверить результат
          ↓
4. npm run process
          ↓
5. npm run validate
```

---

## 📄 Лицензия

MIT License.

