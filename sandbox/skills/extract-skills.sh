#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMBINED="${SCRIPT_DIR}/../../all-skills-combined.md"

export COMBINED_DIR="${SCRIPT_DIR}"

python3 << 'PYEOF'
import re, os

combined_path = os.path.join(os.environ["COMBINED_DIR"], "..", "..", "all-skills-combined.md")
combined_path = os.path.abspath(combined_path)
script_dir = os.environ["COMBINED_DIR"]

with open(combined_path, "r") as f:
    content = f.read()

skills = re.split(r'\n### `(\w[\w-]*)`\n', content)

excluded_skills = {"feature-ideation"}
public_skills = {"docx", "pdf", "pdf-reading", "pptx", "xlsx", "file-reading", "frontend-design", "product-self-knowledge"}

for i in range(1, len(skills), 2):
    name = skills[i]
    body = skills[i+1].strip()

    if name in excluded_skills:
        print(f"Skipping: {name} (handled separately)")
        continue

    if name in public_skills:
        outdir = f"{script_dir}/public/{name}"
    else:
        outdir = f"{script_dir}/examples/{name}"

    os.makedirs(outdir, exist_ok=True)
    with open(f"{outdir}/SKILL.md", "w") as f:
        f.write(f"---\nname: {name}\n---\n\n{body}\n")
    print(f"Extracted: {name} -> {outdir}")
PYEOF

canvas_fonts_src="${SCRIPT_DIR}/../../canvas-design-full/canvas-design-full/canvas-fonts"
if [ -d "${canvas_fonts_src}" ]; then
    mkdir -p "${SCRIPT_DIR}/examples/canvas-design/canvas-fonts"
    cp -r "${canvas_fonts_src}/"* "${SCRIPT_DIR}/examples/canvas-design/canvas-fonts/"
    cp "${SCRIPT_DIR}/../../canvas-design-full/canvas-design-full/LICENSE.txt" \
        "${SCRIPT_DIR}/examples/canvas-design/"
fi

feature_src="${SCRIPT_DIR}/../../feature-ideation-skill/feature-ideation"
if [ -d "${feature_src}" ]; then
    mkdir -p "${SCRIPT_DIR}/user/feature-ideation"
    cp -r "${feature_src}/"* "${SCRIPT_DIR}/user/feature-ideation/"
fi

echo "==> Skill extraction complete."
