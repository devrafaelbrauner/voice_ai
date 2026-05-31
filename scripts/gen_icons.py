#!/usr/bin/env python3
"""
Gera os ícones do app VoiceAI a partir do logo do handoff (Conceito D Vertical Dark).
Reproduz exatamente o SVG do design:
  - Tile: rounded-rect rx=22, gradiente diagonal #5a96c4 -> #2d5a8a
  - Microfone branco: corpo (rect rx16), 3 linhas, arco do suporte, haste, base,
    e arco decorativo inferior.

Desenha com Pillow em supersampling e reduz com LANCZOS para bordas suaves.
"""
import math
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "images")
OUT = os.path.abspath(OUT)

GRAD_TL = (0x5a, 0x96, 0xc4)  # top-left
GRAD_BR = (0x2d, 0x5a, 0x8a)  # bottom-right
WHITE = (255, 255, 255)

SS = 4  # supersampling factor


# ---------- helpers (coordenadas em viewBox 0..100) ----------

def make_gradient(px, rounded):
    """Imagem RGBA px×px com gradiente diagonal. rounded=raio (px) ou None."""
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    grad = Image.new("RGB", (px, px))
    gp = grad.load()
    maxd = (px - 1) * 2 or 1
    for y in range(px):
        for x in range(px):
            t = (x + y) / maxd
            r = round(GRAD_TL[0] + (GRAD_BR[0] - GRAD_TL[0]) * t)
            g = round(GRAD_TL[1] + (GRAD_BR[1] - GRAD_TL[1]) * t)
            b = round(GRAD_TL[2] + (GRAD_BR[2] - GRAD_TL[2]) * t)
            gp[x, y] = (r, g, b)
    img.paste(grad, (0, 0))
    if rounded is not None:
        mask = Image.new("L", (px, px), 0)
        md = ImageDraw.Draw(mask)
        md.rounded_rectangle([0, 0, px - 1, px - 1], radius=rounded, fill=255)
        img.putalpha(mask)
    else:
        img.putalpha(255)
    return img


def quad(p0, p1, p2, n=60):
    pts = []
    for i in range(n + 1):
        t = i / n
        mt = 1 - t
        x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0]
        y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]
        pts.append((x, y))
    return pts


def svg_arc(p1, p2, rx, ry, large, sweep, n=60):
    """Amostra um arco elíptico SVG (sem rotação) em n+1 pontos."""
    x1, y1 = p1
    x2, y2 = p2
    x1p = (x1 - x2) / 2.0
    y1p = (y1 - y2) / 2.0
    lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry)
    if lam > 1:
        s = math.sqrt(lam)
        rx *= s
        ry *= s
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    coef = math.sqrt(max(0.0, num / den))
    if large == sweep:
        coef = -coef
    cxp = coef * (rx * y1p / ry)
    cyp = coef * (-ry * x1p / rx)
    cx = cxp + (x1 + x2) / 2.0
    cy = cyp + (y1 + y2) / 2.0

    def ang(ux, uy, vx, vy):
        dot = ux * vx + uy * vy
        ln = math.hypot(ux, uy) * math.hypot(vx, vy)
        a = math.acos(max(-1.0, min(1.0, dot / ln)))
        if ux * vy - uy * vx < 0:
            a = -a
        return a

    theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dtheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry,
                 (-x1p - cxp) / rx, (-y1p - cyp) / ry)
    if not sweep and dtheta > 0:
        dtheta -= 2 * math.pi
    elif sweep and dtheta < 0:
        dtheta += 2 * math.pi
    pts = []
    for i in range(n + 1):
        th = theta1 + dtheta * (i / n)
        pts.append((cx + rx * math.cos(th), cy + ry * math.sin(th)))
    return pts


class Pen:
    """Desenha em pixels aplicando transform viewBox->pixel (k, ox, oy)."""

    def __init__(self, draw, k, ox, oy):
        self.d = draw
        self.k = k
        self.ox = ox
        self.oy = oy

    def P(self, p):
        return (self.ox + p[0] * self.k, self.oy + p[1] * self.k)

    def polyline(self, pts, w, color, caps=True):
        px = [self.P(p) for p in pts]
        wpx = max(1, round(w * self.k))
        self.d.line(px, fill=color, width=wpx, joint="curved")
        if caps:
            r = wpx / 2.0
            for end in (px[0], px[-1]):
                self.d.ellipse([end[0] - r, end[1] - r, end[0] + r, end[1] + r], fill=color)

    def line(self, p0, p1, w, color, caps=True):
        self.polyline([p0, p1], w, color, caps)

    def rrect_stroke(self, x, y, w, h, rad, sw, color):
        a = self.P((x, y))
        b = self.P((x + w, y + h))
        self.d.rounded_rectangle([a[0], a[1], b[0], b[1]],
                                 radius=rad * self.k,
                                 outline=color, width=max(1, round(sw * self.k)))


def draw_mic(base_img, k, ox, oy, color=WHITE, faint=True):
    """Desenha o microfone (viewBox 0..100) sobre base_img (RGBA)."""
    solid = Image.new("RGBA", base_img.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(solid)
    pen = Pen(sd, k, ox, oy)
    # corpo
    pen.rrect_stroke(34, 12, 32, 40, 16, 2.8, color)
    # arco do suporte
    pen.polyline(quad((26, 53), (26, 72), (50, 72)) + quad((50, 72), (74, 72), (74, 53)),
                 2.8, color)
    # haste + base
    pen.line((50, 72), (50, 83), 2.8, color)
    pen.line((38, 83), (62, 83), 2.8, color)
    base_img.alpha_composite(solid)

    if faint:
        fl = Image.new("RGBA", base_img.size, (0, 0, 0, 0))
        fd = ImageDraw.Draw(fl)
        fpen = Pen(fd, k, ox, oy)
        for yy in (26, 33, 40):
            fpen.line((40, yy), (60, yy), 1.6, color)
        fpen.polyline(svg_arc((34, 90), (66, 90), 18, 9, 0, 1), 1.8, color)
        # aplica opacidade 0.5
        alpha = fl.getchannel("A").point(lambda a: a // 2)
        fl.putalpha(alpha)
        base_img.alpha_composite(fl)


# ---------- builders ----------

def build_full(size, rounded_frac=None):
    """Tile completo. rounded_frac=None -> full-bleed (iOS). senão raio=frac*size."""
    px = size * SS
    rad = None if rounded_frac is None else int(rounded_frac * px)
    img = make_gradient(px, rad)
    draw_mic(img, k=px / 100.0, ox=0, oy=0)
    return img.resize((size, size), Image.LANCZOS)


def build_foreground(size, color=WHITE, faint=True):
    """Microfone centralizado na safe zone (~66%) sobre transparente (adaptive fg)."""
    px = size * SS
    img = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    safe = 0.66
    k = (px * safe) / 100.0
    off = (px - px * safe) / 2.0
    draw_mic(img, k=k, ox=off, oy=off, color=color, faint=faint)
    return img.resize((size, size), Image.LANCZOS)


def build_background(size):
    px = size * SS
    img = make_gradient(px, None)
    return img.resize((size, size), Image.LANCZOS)


def save(img, name):
    path = os.path.join(OUT, name)
    img.save(path, "PNG")
    print(f"  ✓ {name}  ({img.size[0]}×{img.size[1]})")


if __name__ == "__main__":
    print(f"Gerando ícones em {OUT}")
    # App icon (iOS/stores): full-bleed, OS arredonda
    save(build_full(1024, rounded_frac=None), "icon.png")
    # Android adaptive
    save(build_background(1024), "android-icon-background.png")
    save(build_foreground(1024), "android-icon-foreground.png")
    save(build_foreground(1024, faint=False), "android-icon-monochrome.png")
    # Splash: tile arredondado (22%) sobre fundo azul do splash
    save(build_full(1024, rounded_frac=0.22), "splash-icon.png")
    # Favicon web
    save(build_full(96, rounded_frac=None), "favicon.png")
    print("Concluído.")
