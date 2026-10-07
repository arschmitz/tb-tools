"""Export transparent named logos using the approved bird and SF Mono Heavy."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent
FONT = "/System/Library/Fonts/SFNSMono.ttf"
bird = Image.open(ROOT / "dashboard-mythic-kanban-v3.png").convert("RGBA")
bird = bird.crop(bird.getbbox())


def label(text, size, color, bold=False):
    font = ImageFont.truetype(FONT, size)
    font.set_variation_by_name("Heavy")
    widths = {font.getlength(character) for character in text}
    assert len(widths) == 1, "All characters must have equal advance widths."
    bounds = font.getbbox(text)
    layer = Image.new("RGBA", (bounds[2] - bounds[0], bounds[3] - bounds[1]))
    ImageDraw.Draw(layer).text((-bounds[0], -bounds[1]), text, font=font, fill=color)
    return layer


for mode, colors in {
    "light": ("#071B49", "#2356A0"),
    "dark": ("#F4F8FF", "#BEDCFA"),
}.items():
    for layout in ("horizontal", "square"):
        canvas = Image.new("RGBA", (2400, 1000) if layout == "horizontal" else (1600, 1600))
        mark = bird.copy()
        mark.thumbnail((820, 840) if layout == "horizontal" else (1360, 1120), Image.Resampling.LANCZOS)
        title = label("Thunderbird", 170 if layout == "horizontal" else 210, colors[0], True)
        subtitle_size = min(
            range(50, 140),
            key=lambda size: abs(label("Development Dashboard", size, colors[1], True).width - title.width),
        )
        subtitle = label("Development Dashboard", subtitle_size, colors[1], True)
        subtitle = subtitle.resize((title.width, subtitle.height), Image.Resampling.LANCZOS)
        if layout == "horizontal":
            canvas.alpha_composite(mark, (70, (1000 - mark.height) // 2))
            text_x = 960
            text_y = (1000 - title.height - subtitle.height - 65) // 2
            canvas.alpha_composite(title, (text_x, text_y))
            canvas.alpha_composite(subtitle, (text_x, text_y + title.height + 65))
        else:
            canvas.alpha_composite(mark, ((1600 - mark.width) // 2, 45))
            canvas.alpha_composite(title, ((1600 - title.width) // 2, 1175))
            canvas.alpha_composite(subtitle, ((1600 - subtitle.width) // 2, 1380))
        path = ROOT / f"thunderbird-development-dashboard-{layout}-mono-{mode}-v7.png"
        canvas.save(path)
        print(path.name, canvas.size)
