"""Server-authoritative resolution tiers. Never trust a client's unit price."""
from decimal import Decimal

VERSION = 3
GPT25 = frozenset({'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'})
GPT26 = frozenset({'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'})
TIERS = {**{model: ('1K', '2K', '4K') for model in GPT25 | GPT26},
         'gemini-nano-banana-2.1': ('1K', '2K', '4K'),
         'grok-imagine-image-2.0': ('1K', '2K'),
         'seedream-5-5': ('1K', '1.5K', '2K'),
         'seedream-5-0-pro': ('1K', '1.5K', '2K')}


def resolution(model, data):
    choices = TIERS.get(model)
    if not choices:
        return None
    value = data.get('resolution', choices[0])
    if not isinstance(value, str) or value.upper() not in choices:
        raise ValueError('请选择当前模型支持的分辨率档位。')
    value = value.upper()
    if model in ('seedream-5-0-pro', 'seedream-5-5') and data.get('size') == 'custom':
        try:
            pixels = int(data['custom_width']) * int(data['custom_height'])
        except (KeyError, ValueError, TypeError):
            raise ValueError('自定义尺寸无效。') from None
        value = '2K' if pixels > 2601124 else '1K'
    return value


def unit_cost(model, tier, references=0):
    if model not in TIERS or tier not in TIERS[model]:
        raise ValueError('不支持的模型或分辨率。')
    base = Decimal('2') if model == 'seedream-5-0-pro' else Decimal('1')
    rank = (1 if tier == '2K' else 0) if model in ('seedream-5-0-pro', 'seedream-5-5') else TIERS[model].index(tier)
    if references and model in GPT26:
        base += Decimal('0.5')
    if references and model == 'grok-imagine-image-2.0':
        base += Decimal('1')
    return base + Decimal('0.5') * rank


def pixels(server, data):
    """Use documented pixel-size input for BuyToken, retaining selected aspect."""
    tier = resolution(data.get('model'), data)
    if not tier:
        return None
    side = {'1K': 1024, '2K': 2048, '4K': 4096}[tier]
    shape = server.SIZE_OPTIONS.get(data.get('size'), {'width': 1, 'height': 1})
    if data.get('size') == 'custom':
        shape = {'width': int(data['custom_width']), 'height': int(data['custom_height'])}
    # Bound the longest edge; the API receives concrete pixels, not an
    # undocumented quality/resolution enum. Custom sizes supply the aspect.
    scale = side / max(shape['width'], shape['height'])
    width = max(64, round(shape['width'] * scale / 8) * 8)
    height = max(64, round(shape['height'] * scale / 8) * 8)
    return f'{width}x{height}'
