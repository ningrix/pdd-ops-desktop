# -*- coding: utf-8 -*-
"""
手写 RRDBNet —— 用于加载 RealESRGAN_x4plus.pth，不依赖 basicsr。

为什么手写：
  basicsr 依赖 filterpy / opencv-python-headless / addict / yapf，
  在新版 torch 上还有 `torchvision.transforms.functional_tensor` 被移除的兼容问题。
  而 RealESRGAN_x4plus 用的就是标准 RRDBNet，结构固定，手写 80 行即可。

结构（已用 work/models/RealESRGAN_x4plus.pth 的键名和形状核对过）：
  conv_first:  3   -> 64
  body:        23 x RRDB(64)，每个 RRDB 含 3 个 ResidualDenseBlock
  conv_body:   64  -> 64
  conv_up1/2:  64  -> 64   (nearest x2 + conv)
  conv_hr:     64  -> 64
  conv_last:   64  -> 3
  scale = 4
"""
import torch
import torch.nn as nn
import torch.nn.functional as F


def _default_init(scale=0.1):
    return scale


class ResidualDenseBlock(nn.Module):
    """5 层稠密连接块。num_feat=64, num_grow_ch=32。"""

    def __init__(self, num_feat=64, num_grow_ch=32):
        super().__init__()
        self.conv1 = nn.Conv2d(num_feat, num_grow_ch, 3, 1, 1)
        self.conv2 = nn.Conv2d(num_feat + num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv3 = nn.Conv2d(num_feat + 2 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv4 = nn.Conv2d(num_feat + 3 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv5 = nn.Conv2d(num_feat + 4 * num_grow_ch, num_feat, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x):
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(nn.Module):
    """Residual in Residual Dense Block。"""

    def __init__(self, num_feat, num_grow_ch=32):
        super().__init__()
        self.rdb1 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb2 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb3 = ResidualDenseBlock(num_feat, num_grow_ch)

    def forward(self, x):
        out = self.rdb1(x)
        out = self.rdb2(out)
        out = self.rdb3(out)
        return out * 0.2 + x


class RRDBNet(nn.Module):
    def __init__(self, num_in_ch=3, num_out_ch=3, scale=4,
                 num_feat=64, num_block=23, num_grow_ch=32):
        super().__init__()
        self.scale = scale
        if scale == 2:
            num_in_ch = num_in_ch * 4
        elif scale == 1:
            num_in_ch = num_in_ch * 16

        self.conv_first = nn.Conv2d(num_in_ch, num_feat, 3, 1, 1)
        self.body = nn.Sequential(*[RRDB(num_feat, num_grow_ch) for _ in range(num_block)])
        self.conv_body = nn.Conv2d(num_feat, num_feat, 3, 1, 1)

        self.conv_up1 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_hr = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_last = nn.Conv2d(num_feat, num_out_ch, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x):
        if self.scale == 2:
            feat = nn.functional.pixel_unshuffle(x, 2)
        elif self.scale == 1:
            feat = nn.functional.pixel_unshuffle(x, 4)
        else:
            feat = x

        feat = self.conv_first(feat)
        body_feat = self.conv_body(self.body(feat))
        feat = feat + body_feat

        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode='nearest')))
        feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode='nearest')))
        out = self.conv_last(self.lrelu(self.conv_hr(feat)))
        return out


def load_realesrgan(path, scale=4, num_block=23, device='cpu'):
    """加载 RealESRGAN_x4plus.pth，返回 eval 模式的模型。"""
    sd = torch.load(path, map_location=device, weights_only=False)
    # 权重文件里通常是 {'params_ema': {...}} 或 {'params': {...}}
    key = None
    for k in ('params_ema', 'params', 'state_dict'):
        if isinstance(sd, dict) and k in sd:
            key = k
            break
    weights = sd[key] if key else sd

    model = RRDBNet(scale=scale, num_block=num_block)
    # strict=True：结构对不上会立刻抛错，这是刻意留的自检
    missing, unexpected = model.load_state_dict(weights, strict=False)
    model.eval()
    for p in model.parameters():
        p.requires_grad = False
    return model, {'missing': list(missing), 'unexpected': list(unexpected), 'key': key}
