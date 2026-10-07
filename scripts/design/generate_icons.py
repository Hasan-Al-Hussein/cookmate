"""Draw CookMate's authored 24-unit line icons as transparent 96px PNGs.

Requires Pillow. No font, network, recipe-photo or third-party icon input is used.
Run from any directory; the output path is relative to this script's repository.
"""

from math import cos, pi, sin
from pathlib import Path

from PIL import Image, ImageDraw


OUTPUT = Path(__file__).resolve().parents[2] / "apps/mobile/assets/icons"
SIZE = 96
SCALE = 16
STROKE = 1.65
INK = (0, 0, 0, 255)


class Icon:
    def __init__(self):
        self.image = Image.new("RGBA", (24 * SCALE, 24 * SCALE))
        self.draw = ImageDraw.Draw(self.image)

    def line(self, points, width=STROKE, closed=False):
        points = [tuple(round(value * SCALE) for value in point) for point in points]
        if closed:
            points.append(points[0])
        stroke = round(width * SCALE)
        self.draw.line(points, fill=INK, width=stroke, joint="curve")
        radius = stroke / 2
        for x, y in points:
            self.draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=INK)

    def curve(self, start, segments, fill=False):
        points = [start]
        for control_a, control_b, end in segments:
            x, y = points[-1]
            for step in range(1, 41):
                t = step / 40
                u = 1 - t
                points.append((
                    u**3 * x + 3 * u**2 * t * control_a[0]
                    + 3 * u * t**2 * control_b[0] + t**3 * end[0],
                    u**3 * y + 3 * u**2 * t * control_a[1]
                    + 3 * u * t**2 * control_b[1] + t**3 * end[1],
                ))
        if fill:
            self.draw.polygon([(round(x * SCALE), round(y * SCALE)) for x, y in points], fill=INK)
        else:
            self.line(points)

    def circle(self, center, radius, filled=False):
        x, y = center
        box = tuple(round(value * SCALE) for value in (x-radius, y-radius, x+radius, y+radius))
        self.draw.ellipse(box, fill=INK if filled else None, outline=None if filled else INK,
                          width=round(STROKE * SCALE))

    def rectangle(self, box, radius=2):
        self.draw.rounded_rectangle(tuple(round(value*SCALE) for value in box),
                                    radius=round(radius*SCALE), outline=INK,
                                    width=round(STROKE*SCALE))

    def save(self, name):
        self.image.resize((SIZE, SIZE), Image.Resampling.LANCZOS).save(OUTPUT / f"{name}.png")


def draw_icon(name):
    icon = Icon()
    if name in ("home", "homeFilled"):
        outline = [(3, 10.5), (12, 3.5), (21, 10.5), (19, 10.5), (19, 20),
                   (14.7, 20), (14.7, 13.3), (9.3, 13.3), (9.3, 20), (5, 20), (5, 10.5)]
        if name == "homeFilled":
            icon.draw.polygon([(round(x*SCALE), round(y*SCALE)) for x, y in outline], fill=INK)
        else:
            icon.line(outline, closed=True)
    elif name in ("heart", "heartFilled"):
        icon.curve((12, 20), [((9.5, 17.8), (3, 13.7), (3, 8.6)),
                   ((3, 3.4), (9.5, 2.2), (12, 6.8)),
                   ((14.5, 2.2), (21, 3.4), (21, 8.6)),
                   ((21, 13.7), (14.5, 17.8), (12, 20))], fill=name == "heartFilled")
    elif name == "calendar":
        icon.rectangle((3.5, 5.5, 20.5, 21), 2.4)
        icon.line([(7.5, 3), (7.5, 7.5)])
        icon.line([(16.5, 3), (16.5, 7.5)])
        icon.line([(4, 10), (20, 10)])
        for x, y in [(8, 14), (12, 14), (16, 14), (8, 17.5), (12, 17.5)]:
            icon.circle((x, y), .7, True)
    elif name == "chat":
        icon.curve((7, 4), [((4.8, 4), (3.5, 5.3), (3.5, 7.5))])
        icon.line([(3.5, 7.5), (3.5, 20.5), (8, 17.5), (17, 17.5)])
        icon.curve((17, 17.5), [((19.2, 17.5), (20.5, 16.2), (20.5, 14)),
                   ((20.5, 12), (20.5, 9.5), (20.5, 7.5)),
                   ((20.5, 5.3), (19.2, 4), (17, 4))])
        icon.line([(17, 4), (7, 4)])
        icon.line([(7.8, 8.8), (16.2, 8.8)])
        icon.line([(7.8, 12.5), (13.8, 12.5)])
    elif name == "sparkle":
        icon.line([(9, 3), (11.4, 8.6), (17, 11), (11.4, 13.4),
                   (9, 19), (6.6, 13.4), (1, 11), (6.6, 8.6)], closed=True)
        icon.line([(18, 14), (19.2, 16.8), (22, 18), (19.2, 19.2),
                   (18, 22), (16.8, 19.2), (14, 18), (16.8, 16.8)], closed=True)
    elif name == "settings":
        points = []
        for step in range(32):
            angle = 2*pi*step/32 - pi/8
            radius = (7.0, 8.7, 8.7, 7.0)[step % 4]
            points.append((12 + cos(angle)*radius, 12 + sin(angle)*radius))
        icon.line(points, closed=True)
        icon.circle((12, 12), 3.1)
    elif name == "back":
        icon.line([(10, 5), (3, 12), (10, 19)])
        icon.line([(3, 12), (21, 12)])
    elif name in ("chevronLeft", "chevronRight"):
        icon.line([(14.5, 5), (7.5, 12), (14.5, 19)] if name == "chevronLeft"
                  else [(9.5, 5), (16.5, 12), (9.5, 19)])
    elif name == "search":
        icon.circle((10.4, 10.4), 6.6)
        icon.line([(15.3, 15.3), (21, 21)])
    elif name == "filter":
        for y, x in [(6, 8), (12, 16), (18, 10)]:
            icon.line([(3, y), (x-2.1, y)])
            icon.line([(x+2.1, y), (21, y)])
            icon.circle((x, y), 2.1)
    elif name == "close":
        icon.line([(6, 6), (18, 18)])
        icon.line([(18, 6), (6, 18)])
    elif name == "plus":
        icon.line([(12, 4.5), (12, 19.5)])
        icon.line([(4.5, 12), (19.5, 12)])
    elif name == "check":
        icon.line([(4, 12), (9.4, 17.2), (20, 6.8)])
    elif name == "more":
        for x in (5, 12, 19):
            icon.circle((x, 12), 1.25, True)
    elif name == "leaf":
        icon.curve((5.3, 18.7), [((.6, 8.6), (13, 2), (20.5, 3.5)),
                   ((22, 11), (15.4, 23.4), (5.3, 18.7))])
        icon.curve((3, 21), [((7.5, 15), (12, 12), (16.4, 8))])
        icon.line([(10.6, 13.1), (10.8, 8.7)])
        icon.line([(10.6, 13.1), (15, 13.1)])
    elif name == "sun":
        icon.circle((12, 12), 4.2)
        for step in range(8):
            angle = step*pi/4
            icon.line([(12+cos(angle)*7.3, 12+sin(angle)*7.3),
                       (12+cos(angle)*9.7, 12+sin(angle)*9.7)])
    elif name == "moon":
        icon.curve((20.5, 14.6), [((17, 23.5), (4, 21.5), (3.5, 12)),
                   ((3.1, 7.1), (6.4, 3.4), (10.8, 3.1)),
                   ((8.2, 7.4), (12, 16.9), (20.5, 14.6))])
    elif name == "coffee":
        icon.line([(4, 8), (16.5, 8), (16.5, 14.5)])
        icon.curve((16.5, 14.5), [((16.5, 18.5), (4, 18.5), (4, 14.5))])
        icon.line([(4, 14.5), (4, 8)])
        icon.curve((16.5, 8.5), [((22, 7), (22, 15.5), (16.5, 14))])
        icon.line([(3, 20), (19, 20)])
        icon.curve((8, 5.7), [((6, 4.3), (10, 3.6), (8, 2.2))])
        icon.curve((12.5, 5.7), [((10.5, 4.3), (14.5, 3.6), (12.5, 2.2))])
    elif name == "shopping":
        icon.line([(5, 8), (19, 8), (20.5, 21), (3.5, 21)], closed=True)
        icon.curve((8.5, 10), [((8.5, 7), (8, 3), (12, 3)),
                   ((16, 3), (15.5, 7), (15.5, 10))])
    elif name == "book":
        icon.curve((12, 5.5), [((8.8, 3.4), (6, 3.4), (3, 4.5))])
        icon.line([(3, 4.5), (3, 19)])
        icon.curve((3, 19), [((6, 17.9), (8.8, 17.9), (12, 20)),
                   ((15.2, 17.9), (18, 17.9), (21, 19))])
        icon.line([(21, 19), (21, 4.5)])
        icon.curve((21, 4.5), [((18, 3.4), (15.2, 3.4), (12, 5.5))])
        icon.line([(12, 5.5), (12, 20)])
    elif name == "globe":
        icon.circle((12, 12), 9)
        icon.line([(3, 12), (21, 12)])
        icon.curve((12, 3), [((5.5, 7), (5.5, 17), (12, 21)),
                   ((18.5, 17), (18.5, 7), (12, 3))])
    elif name == "external":
        icon.line([(13, 3), (21, 3), (21, 11)])
        icon.line([(21, 3), (10, 14)])
        icon.line([(10, 5), (4, 5), (4, 21), (19, 21), (19, 14)])
    elif name == "info":
        icon.circle((12, 12), 9)
        icon.circle((12, 7.7), .9, True)
        icon.line([(12, 11.1), (12, 16.5)])
    else:
        raise ValueError(f"Unknown icon: {name}")
    icon.save(name)


if __name__ == "__main__":
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name in ("home", "heart", "calendar", "chat", "settings", "back", "chevronRight",
                 "chevronLeft", "search", "filter", "close", "plus", "check", "more", "leaf",
                 "sun", "moon", "coffee", "shopping", "book", "info", "homeFilled", "heartFilled", "globe", "external", "sparkle"):
        draw_icon(name)
    print("Generated 26 transparent 96x96 CookMate icons.")
