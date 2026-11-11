#!/usr/bin/env python3
"""Unlock all context-window gates in the agy CLI (plus optional env-var restore).

Verified end-to-end on macOS (arm64), Linux (x86-64 & arm64), and Windows
(x86-64 & arm64), agy 1.4.12 - 1.5.3. Container + Go pclntab locating supports
Mach-O, ELF, and PE (arm64 & x86-64).

Gate 1 -- model.SelectorModel.offersContextWindow
    Exposes /model -> Context: [Default] [256K] [512K] [900K] (Tab key) for all
    models instead of gating on "Gemini 4 Argon" + internal experiment state.
        arm64 : mov w0, #1 ; ret           -> 20 00 80 52 c0 03 5f d6
        x86-64: mov eax, 1 ; ret           -> b8 01 00 00 00 c3

Gate 2 -- store.(*Store).ContextWindow -> store.(*Store).ContextWindowChoice
    Bypasses the "Gemini 4 Argon" whitelist and release-folded experiment gate
    so Store.ContextWindow() returns the user's persisted ContextWindowChoice
    ("256K", "512K", "900K", or "" for Default) to Manager.syncContextWindow().
    On arm64, preserves store.AutoCompactOverride priority before tail-calling
    Store.ContextWindowChoice with a clean deallocated frame (Go PCDATA safe);
    falls back to a direct entry tail-jump on x86-64 or altered layouts.

Gate 3A -- utils.GetCheckpointConfig
    Removes the hardcoded min(threshold, 256000) (0x3e800) ceiling inside
    cortex/utils/utils.GetCheckpointConfig so defaultCp.MaxTokenLimit holds the
    model's full physical budget: contextWindow - max(maxOutputTokens, 40000)
    (983,040 tokens on 1M-context / 64K-output models).
        arm64 : 24-byte 0x3e800 cmp/csel   -> 6 x nop (1f 20 03 d5)
        x86-64: 14-byte 0x3e800 cmp/cmovb  -> mov %edx, %esi + 12 x nop

Gate 3B -- config.applyFeatureProviderCheckpointOverrideConfig
    Clears expCp.MaxTokenLimit (offset +0xc) before MergeConfigsDedup merges
    CASCADE_USE_EXPERIMENT_CHECKPOINTER (which hardcodes "max_token_limit":
    "256000" in model_profiles), preserving defaultCp.MaxTokenLimit (983,040)
    while retaining all modern checkpointer strategy and summary settings.

Gate 4A -- chatconverters.(*TrajectoryChatConverter).getMaxTokensForStep
    Bypasses the hardcoded MaxTokensPerUserInputStep = 64000 (192,000 bytes)
    per-step truncation on USER_INPUT steps by returning 0 for step types 8
    and 19, while preserving MaxTokensPerStep = 16,384 for non-user/tool steps.
        arm64 : mov x2, xzr ; b <epilogue mv x0,x2> at the USER_INPUT branch
        x86-64: xor %eax, %eax ; jmp <epilogue dealloc>

Gate 4B -- serializers.DefaultSerializer.stepToMessage (OneHarness, agy >= 1.5.0)
    Routes STEP_TYPE_USER_INPUT (0xe) to the zero-token-limit branch so the
    OneHarness / AgentScript serialiser drops its 64K (192,000-byte) clamp,
    while STEP_TYPE_CHECKPOINT (0x17) keeps limit = 0 (unlimited) and every
    other step keeps MaxTokensPerStep = 16,384.
        arm64 : b.eq <rel+16 mov xM,xzr>  (was b.eq <rel+24>, skipping it)
        x86-64: je <xor zeroing>          (rel8 displacement widened)

Bonus  -- store.AutoCompactOverride (arm64, optional; skip with --no-env-fix)
    Restores os.Getenv("AGY_CLI_AUTO_COMPACT_OVERRIDE") in place of the
    constant-folded strings.TrimSpace("") call so percentage ("80%") or integer
    token overrides ("650000") work via environment variable.

Usage:
    python3 agy-patch.py --binary ~/.local/bin/agy --in-place
    python3 agy-patch.py --binary ~/.local/bin/agy --locate
    python3 agy-patch.py --binary ~/.local/bin/agy --dry-run
"""

import argparse
import hashlib
import os
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import tempfile

PCLNTAB_MAGIC = 0xFFFFFFF1
ENV_NAME = b"AGY_CLI_AUTO_COMPACT_OVERRIDE"

FUNC_OFFERS = "model.SelectorModel.offersContextWindow"
FUNC_STORE_CW = "store.(*Store).ContextWindow"
FUNC_STORE_CHOICE = "store.(*Store).ContextWindowChoice"
FUNC_CHECKPOINT = "utils.GetCheckpointConfig"
FUNC_EXP_CHECKPOINT = "config.applyFeatureProviderCheckpointOverrideConfig"
FUNC_SELECT_EXP_KEY = "config.selectCheckpointExperimentKey"
FUNC_MAX_STEP_TOKENS = "chatconverters.(*TrajectoryChatConverter).getMaxTokensForStep"
FUNC_ONEHARNESS_STEP = "serializers.DefaultSerializer.stepToMessage"
FUNC_OVERRIDE = "store.AutoCompactOverride"

NOP_ARM64 = struct.pack("<I", 0xD503201F)
RET_TRUE_ARM64 = struct.pack("<II", 0x52800020, 0xD65F03C0)      # mov w0,#1 ; ret
RET_TRUE_X64 = bytes.fromhex("b801000000c3")                     # mov eax,1 ; ret

# arm64 folded Getenv setup: nop ; mov x0,xzr ; mov x1,xzr
GETENV_STUB_ARM64 = struct.pack("<III", 0xD503201F, 0xAA1F03E0, 0xAA1F03E1)

# Gate 3 exact 0x3e800 (256,000) clamp sequences inside utils.GetCheckpointConfig
CLAMP_256K_ARM64 = bytes.fromhex(
    "04009dd2"  # mov  x4, #0xe800
    "6400a0f2"  # movk x4, #0x3, lsl #16   (0x3e800 = 256000)
    "7f00046b"  # cmp  w3, w4
    "04009dd2"  # mov  x4, #0xe800
    "6400a0f2"  # movk x4, #0x3, lsl #16
    "6330849a"  # csel x3, x3, x4, lo
)
CLAMP_256K_X64 = bytes.fromhex(
    "81fa00e80300"  # cmp  $0x3e800, %edx
    "be00e80300"    # mov  $0x3e800, %esi
    "0f42f2"        # cmovb %edx, %esi
)
PATCH_256K_X64 = bytes.fromhex("89d6") + b"\x90" * 12  # mov %edx, %esi + 12x nop

# Gate 4A step-type dispatch (USER_INPUT = 8 and 19) and return-value plumbing
USER_INPUT_STEP_TYPES = (0x8, 0x13)
MOV_X2_XZR = 0xAA1F03E2   # mov x2, xzr
MOV_X0_X2 = 0xAA0203E0    # mov x0, x2 (epilogue return-value setup)
X64_ZERO_EAX = b"\x31\xc0"  # xor %eax, %eax

# Gate 4B OneHarness stepToMessage dispatch: `cmp wR,#0xe ; b.eq ...`
ONEHARNESS_BEQ_WORD = 0x540000C0   # b.eq +0x18 (skips the zero-limit branch)
ONEHARNESS_BEQ_PATCHED = 0x54000060  # b.eq +0xc (lands on mov xM, xzr)


class PatchError(Exception):
    pass


# --------------------------------------------------------------------------
# Binary container: locate machine-code section (.text / __text)
# --------------------------------------------------------------------------

def find_text_section(data):
    """Return (text_vmaddr, text_fileoff, arch)."""
    if data[:4] == b"\xcf\xfa\xed\xfe":
        return _macho_text(data)
    if data[:4] == b"\x7fELF":
        return _elf_text(data)
    if data[:2] == b"MZ":
        return _pe_text(data)
    raise PatchError("unrecognised binary container (expected Mach-O, ELF, or PE)")


def _macho_text(data):
    ncmds = struct.unpack_from("<I", data, 16)[0]
    cputype = struct.unpack_from("<I", data, 4)[0]
    arch = {0x0100000C: "arm64", 0x01000007: "x86-64"}.get(cputype)
    if arch is None:
        raise PatchError(f"unsupported Mach-O cputype {cputype:#x}")
    off = 32
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", data, off)
        if cmd == 0x19:  # LC_SEGMENT_64
            nsects = struct.unpack_from("<I", data, off + 64)[0]
            sect = off + 72
            for _ in range(nsects):
                if data[sect:sect + 16].rstrip(b"\0") == b"__text":
                    addr, _sz, offset = struct.unpack_from("<QQI", data, sect + 32)
                    return addr, offset, arch
                sect += 80
        off += size
    raise PatchError("__text section not found in Mach-O")


def _elf_file_to_va(data, file_off):
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phentsize, phnum = struct.unpack_from("<HH", data, 54)
    for i in range(phnum):
        ph = phoff + i * phentsize
        if ph + 40 > len(data):
            break
        if struct.unpack_from("<I", data, ph)[0] != 1:  # PT_LOAD
            continue
        p_offset, p_vaddr, _p_paddr, p_filesz = struct.unpack_from("<QQQQ", data, ph + 8)
        if p_offset <= file_off < p_offset + p_filesz:
            return p_vaddr + (file_off - p_offset)
    return None


def _elf_go_text_va(data, t_va, t_sz, relas, symtabs):
    """Locate Go `runtime.text` inside ELF `.text`.

    External C linkers (glibc / musl cgo PIE) place CRT startup stubs at the
    head of `.text` (`+0x80` on glibc x86-64, `+0xc0` on musl x86-64 and glibc
    arm64), while Go `functab` `entryoff` values are relative to `runtime.text`.
    """
    pcln_off, _ = find_pclntab(data)
    text_start, funcname_off = struct.unpack_from("<QQ", data, pcln_off + 24)
    if t_va <= text_start < t_va + t_sz:
        return text_start

    pcln_va = _elf_file_to_va(data, pcln_off)
    if pcln_va is not None:
        fn_va = pcln_va + funcname_off
        needle = struct.pack("<q", pcln_va)
        for roff, rsz, entsz in relas:
            pos = roff
            end = roff + rsz
            while True:
                hit = data.find(needle, pos, end)
                if hit < 0:
                    break
                pos = hit + 1
                if (hit - roff) % entsz != 16:
                    continue
                ep = hit - 16
                if ep + 2 * entsz > end:
                    continue
                mod_va = struct.unpack_from("<Q", data, ep)[0]
                r_off2, _, r_add2 = struct.unpack_from("<QQq", data, ep + entsz)
                if r_off2 != mod_va + 8 or r_add2 != fn_va:
                    continue
                mod_text = mod_etext = None
                for k in range(2, 24):
                    if ep + (k + 1) * entsz > end:
                        break
                    ro, _, ra = struct.unpack_from("<QQq", data, ep + k * entsz)
                    if ro == mod_va + 0xB0:
                        mod_text = ra
                    elif ro == mod_va + 0xB8:
                        mod_etext = ra
                if (mod_text is not None and mod_etext is not None
                        and t_va <= mod_text < mod_etext <= t_va + t_sz):
                    return mod_text

        pair = struct.pack("<QQ", pcln_va, fn_va)
        pos = 0
        while True:
            hit = data.find(pair, pos)
            if hit < 0 or hit + 0xC0 > len(data):
                break
            pos = hit + 1
            mod_text, mod_etext = struct.unpack_from("<QQ", data, hit + 0xB0)
            if t_va <= mod_text < mod_etext <= t_va + t_sz:
                return mod_text

    for sym_off, sym_sz, entsz, str_off in symtabs:
        for pos in range(sym_off, sym_off + sym_sz, entsz):
            if pos + 24 > len(data):
                break
            st_name, _info, _other, _shndx, st_val, _sz = struct.unpack_from("<IBBHQQ", data, pos)
            end = data.find(b"\0", str_off + st_name, str_off + st_name + 64)
            if end > 0 and data[str_off + st_name:end] == b"runtime.text":
                if t_va <= st_val < t_va + t_sz:
                    return st_val

    raise PatchError("cannot locate Go runtime.text base in ELF")


def _elf_text(data):
    if data[4] != 2 or data[5] != 1:
        raise PatchError("only 64-bit little-endian ELF is supported")
    machine = struct.unpack_from("<H", data, 18)[0]
    arch = {0xB7: "arm64", 0x3E: "x86-64"}.get(machine)
    if arch is None:
        raise PatchError(f"unsupported ELF machine {machine:#x}")
    shoff = struct.unpack_from("<Q", data, 40)[0]
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", data, 58)
    strtab_off = struct.unpack_from("<Q", data, shoff + shstrndx * shentsize + 24)[0]
    text_sec = None
    relas = []
    symtabs = []
    for i in range(shnum):
        sh = shoff + i * shentsize
        nameoff, sh_type = struct.unpack_from("<II", data, sh)
        end = data.find(b"\0", strtab_off + nameoff)
        if data[strtab_off + nameoff:end] == b".text":
            addr, offset, size = struct.unpack_from("<QQQ", data, sh + 16)
            text_sec = (addr, offset, size)
        elif sh_type == 4:  # SHT_RELA
            r_off, r_sz = struct.unpack_from("<QQ", data, sh + 24)
            r_ent = struct.unpack_from("<Q", data, sh + 56)[0] or 24
            relas.append((r_off, r_sz, r_ent))
        elif sh_type == 2:  # SHT_SYMTAB
            s_off, s_sz = struct.unpack_from("<QQ", data, sh + 24)
            s_link = struct.unpack_from("<I", data, sh + 40)[0]
            s_ent = struct.unpack_from("<Q", data, sh + 56)[0] or 24
            if s_link < shnum:
                s_str = struct.unpack_from("<Q", data, shoff + s_link * shentsize + 24)[0]
                symtabs.append((s_off, s_sz, s_ent, s_str))
    if text_sec is None:
        raise PatchError(".text section not found in ELF")
    t_va, t_off, t_sz = text_sec
    go_va = _elf_go_text_va(data, t_va, t_sz, relas, symtabs)
    return go_va, t_off + (go_va - t_va), arch


def _pe_text(data):
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        raise PatchError("invalid PE header signature")
    machine = struct.unpack_from("<H", data, pe + 4)[0]
    arch = {0xAA64: "arm64", 0x8664: "x86-64"}.get(machine)
    if arch is None:
        raise PatchError(f"unsupported PE machine {machine:#x}")
    nsec = struct.unpack_from("<H", data, pe + 6)[0]
    opt_size = struct.unpack_from("<H", data, pe + 20)[0]
    opt = pe + 24
    image_base = struct.unpack_from("<Q", data, opt + 24)[0]
    sect = opt + opt_size
    for _ in range(nsec):
        if data[sect:sect + 8].rstrip(b"\0") == b".text":
            _vsize, vaddr, _rawsize, rawptr = struct.unpack_from("<IIII", data, sect + 8)
            return image_base + vaddr, rawptr, arch
        sect += 40
    raise PatchError(".text section not found in PE")


# --------------------------------------------------------------------------
# Go .gopclntab symbol resolution
# --------------------------------------------------------------------------

def find_pclntab(data):
    magic = struct.pack("<I", PCLNTAB_MAGIC) + b"\x00\x00"
    pos = 0
    while True:
        i = data.find(magic, pos)
        if i < 0:
            raise PatchError("Go pclntab not found")
        pos = i + 1
        # minLC is 1 on x86-64, 2 on s390x, 4 on arm64; ptrSize is 8 on 64-bit
        if data[i + 6] not in (1, 2, 4) or data[i + 7] != 8:
            continue
        nfunc = struct.unpack_from("<Q", data, i + 8)[0]
        if not 1000 < nfunc < 5_000_000:
            continue
        fn_off = struct.unpack_from("<Q", data, i + 32)[0]
        if i + fn_off + 16 > len(data):
            continue
        head = data[i + fn_off:i + fn_off + 16]
        if not head or not all(0x20 <= c < 0x7F or c == 0 for c in head):
            continue
        return i, nfunc


def build_functions(data):
    """Map trailing Go func name -> (entryoff, size)."""
    base, nfunc = find_pclntab(data)
    fnstart = base + struct.unpack_from("<Q", data, base + 32)[0]
    pcln = base + struct.unpack_from("<Q", data, base + 64)[0]

    funcs = {}
    for i in range(nfunc):
        off = pcln + i * 8
        if off + 16 > len(data):
            break
        entryoff, funcoff = struct.unpack_from("<II", data, off)
        next_entryoff = struct.unpack_from("<I", data, off + 8)[0]
        rec = pcln + funcoff
        if rec + 8 > len(data):
            continue
        nameoff = struct.unpack_from("<i", data, rec + 4)[0]
        start = fnstart + nameoff
        end = data.find(b"\x00", start, start + 1024)
        if end < 0:
            continue
        try:
            name = data[start:end].decode("ascii")
        except UnicodeDecodeError:
            continue
        size = max(0, next_entryoff - entryoff)
        funcs.setdefault(name.rsplit("/", 1)[-1], (entryoff, size))
    if not funcs:
        raise PatchError("functab produced no symbols")
    return funcs


# --------------------------------------------------------------------------
# Instruction encoders / helpers
# --------------------------------------------------------------------------

def encode_adrp(rd, pc, target):
    delta = ((target & ~0xFFF) - (pc & ~0xFFF)) >> 12
    if not -(1 << 20) <= delta < (1 << 20):
        raise PatchError("adrp target out of range")
    imm21 = delta & 0x1FFFFF
    return 0x90000000 | ((imm21 & 3) << 29) | ((imm21 >> 2) << 5) | rd


def encode_add_imm(rd, rn, imm12):
    if not 0 <= imm12 <= 0xFFF:
        raise PatchError("add immediate out of range")
    return 0x91000000 | (imm12 << 10) | (rn << 5) | rd


def encode_movz64(rd, imm16):
    return 0xD2800000 | (imm16 << 5) | rd


def encode_b(pc, target):
    delta = target - pc
    if delta & 3 or not -(1 << 27) <= delta < (1 << 27):
        raise PatchError("b target out of range")
    return 0x14000000 | ((delta >> 2) & 0x3FFFFFF)


def encode_bl(pc, target):
    delta = target - pc
    if delta & 3 or not -(1 << 27) <= delta < (1 << 27):
        raise PatchError("bl target out of range")
    return 0x94000000 | ((delta >> 2) & 0x3FFFFFF)


def decode_bl_target(pc, word):
    if (word & 0xFC000000) != 0x94000000:
        return None
    imm26 = word & 0x3FFFFFF
    if imm26 & 0x2000000:
        imm26 -= 0x4000000
    return pc + imm26 * 4


# --------------------------------------------------------------------------
# Gate 1: model.SelectorModel.offersContextWindow -> return true
# --------------------------------------------------------------------------

def patch_gate1_ui(data, funcs, text_va, text_off, arch):
    if FUNC_OFFERS not in funcs:
        raise PatchError(f"symbol not found: {FUNC_OFFERS}")
    entryoff, _ = funcs[FUNC_OFFERS]
    blob = RET_TRUE_ARM64 if arch == "arm64" else RET_TRUE_X64
    off = text_off + entryoff
    if bytes(data[off:off + len(blob)]) == blob:
        return False, f"[Gate 1] {FUNC_OFFERS}: already patched"
    data[off:off + len(blob)] = blob
    return True, (f"[Gate 1] {FUNC_OFFERS}: entry {text_va + entryoff:#x} -> "
                  f"return true ({blob.hex(' ')})")


# --------------------------------------------------------------------------
# Gate 2: store.(*Store).ContextWindow -> store.(*Store).ContextWindowChoice
# --------------------------------------------------------------------------

def _try_arm64_rich_gate2(data, funcs, text_va, text_off):
    """Preserve AutoCompactOverride priority, then tail-call ContextWindowChoice.

    Returns (handled: bool, changed: bool, message: str).
    """
    if FUNC_OVERRIDE not in funcs:
        return False, False, ""

    cw_entry, cw_size = funcs[FUNC_STORE_CW]
    ch_entry, _ = funcs[FUNC_STORE_CHOICE]
    ov_entry, _ = funcs[FUNC_OVERRIDE]

    fn_off = text_off + cw_entry
    fn_va = text_va + cw_entry
    ch_va = text_va + ch_entry
    ov_va = text_va + ov_entry

    if cw_size < 0x100:
        return False, False, ""

    # 1. Locate `str x0, [sp, #imm]` in prologue (saves receiver s *Store)
    ldr_x0_sp = None
    for rel in range(0, min(0x40, cw_size), 4):
        w = struct.unpack_from("<I", data, fn_off + rel)[0]
        if (w & 0xFFC003FF) == 0xF90003E0:
            ldr_x0_sp = 0xF94003E0 | (w & 0x003FFC00)
            break
    if ldr_x0_sp is None:
        return False, False, ""

    # 2. Locate `mov x0, #-1` followed by `tbnz x0, #0x3f, ...` (or already nop)
    argon_br_rel = None
    for rel in range(0x40, cw_size - 8, 4):
        w0, w1 = struct.unpack_from("<II", data, fn_off + rel)
        if w0 == 0x92800000 and ((w1 & 0xFFF8001F) == 0xB7F80000 or w1 == 0xD503201F):
            argon_br_rel = rel + 4
            break
    if argon_br_rel is None:
        return False, False, ""

    # 3. Locate `bl store.AutoCompactOverride` + `cbnz x1, epilogue`
    bl_ov_rel = None
    for rel in range(argon_br_rel + 4, cw_size - 24, 4):
        w = struct.unpack_from("<I", data, fn_off + rel)[0]
        if decode_bl_target(fn_va + rel, w) == ov_va:
            bl_ov_rel = rel
            break
    if bl_ov_rel is None:
        return False, False, ""

    w_cbnz = struct.unpack_from("<I", data, fn_off + bl_ov_rel + 4)[0]
    if (w_cbnz & 0xFF00001F) != 0xB5000001:
        return False, False, ""
    imm19 = (w_cbnz >> 5) & 0x7FFFF
    if imm19 & 0x40000:
        imm19 -= 0x80000
    epi_rel = bl_ov_rel + 4 + imm19 * 4
    if not (0 < epi_rel <= cw_size - 12):
        return False, False, ""

    epi_w0, epi_w1, epi_w2 = struct.unpack_from("<III", data, fn_off + epi_rel)
    if epi_w2 != 0xD65F03C0:  # ret
        return False, False, ""

    # Skip optional compiler nop right after cbnz
    tail_rel = bl_ov_rel + 8
    if struct.unpack_from("<I", data, fn_off + tail_rel)[0] == 0xD503201F:
        tail_rel += 4
    if tail_rel + 16 > epi_rel:
        return False, False, ""

    b_choice = encode_b(fn_va + tail_rel + 12, ch_va)
    tail_blob = struct.pack("<IIII", ldr_x0_sp, epi_w0, epi_w1, b_choice)

    argon_site = fn_off + argon_br_rel
    tail_site = fn_off + tail_rel

    already_nop = bytes(data[argon_site:argon_site + 4]) == NOP_ARM64
    already_tail = bytes(data[tail_site:tail_site + 16]) == tail_blob
    if already_nop and already_tail:
        return True, False, f"[Gate 2] {FUNC_STORE_CW}: already patched"

    data[argon_site:argon_site + 4] = NOP_ARM64
    data[tail_site:tail_site + 16] = tail_blob
    return True, True, (
        f"[Gate 2] {FUNC_STORE_CW}: whitelist bypassed @ {fn_va + argon_br_rel:#x} "
        f"+ tail-call {FUNC_STORE_CHOICE} @ {fn_va + tail_rel:#x}"
    )


def patch_gate2_store(data, funcs, text_va, text_off, arch):
    for sym in (FUNC_STORE_CW, FUNC_STORE_CHOICE):
        if sym not in funcs:
            raise PatchError(f"symbol not found: {sym}")

    cw_entry, _ = funcs[FUNC_STORE_CW]
    ch_entry, _ = funcs[FUNC_STORE_CHOICE]
    fn_off = text_off + cw_entry
    fn_va = text_va + cw_entry
    ch_va = text_va + ch_entry

    if arch == "arm64":
        entry_jmp = struct.pack("<I", encode_b(fn_va, ch_va))
        if bytes(data[fn_off:fn_off + 4]) == entry_jmp:
            return False, f"[Gate 2] {FUNC_STORE_CW}: already patched (entry jump)"
        handled, changed, msg = _try_arm64_rich_gate2(data, funcs, text_va, text_off)
        if handled:
            return changed, msg
        data[fn_off:fn_off + 4] = entry_jmp
        return True, (f"[Gate 2] {FUNC_STORE_CW}: entry {fn_va:#x} -> "
                      f"b {FUNC_STORE_CHOICE} ({entry_jmp.hex(' ')})")

    # x86-64: 5-byte jmp rel32 at entry -> ContextWindowChoice (%rax receiver intact)
    rel32 = ch_va - (fn_va + 5)
    if not -(1 << 31) <= rel32 < (1 << 31):
        raise PatchError("jmp rel32 out of range for Store.ContextWindow")
    entry_jmp = b"\xe9" + struct.pack("<i", rel32)
    if bytes(data[fn_off:fn_off + 5]) == entry_jmp:
        return False, f"[Gate 2] {FUNC_STORE_CW}: already patched"
    data[fn_off:fn_off + 5] = entry_jmp
    return True, (f"[Gate 2] {FUNC_STORE_CW}: entry {fn_va:#x} -> "
                  f"jmp {FUNC_STORE_CHOICE} ({entry_jmp.hex(' ')})")


# --------------------------------------------------------------------------
# Gate 3A: utils.GetCheckpointConfig -> remove 256,000 (0x3e800) ceiling
# --------------------------------------------------------------------------

def _find_generic_arm64_256k_clamp(body):
    """Fallback matcher for mov xR,#0xe800 ; movk xR,#3,lsl#16 ... csel xD,xD,xR,lo."""
    hits = []
    for rel in range(0, len(body) - 24, 4):
        w0, w1 = struct.unpack_from("<II", body, rel)
        if (w0 & 0xFFFFFFE0) != 0xD29D0000 or (w1 & 0xFFFFFFE0) != 0xF2A00060:
            continue
        reg_lim = w0 & 0x1F
        if (w1 & 0x1F) != reg_lim:
            continue
        # Look ahead up to 5 instructions for `csel xD, xD, xR, lo`
        for end_rel in range(rel + 12, min(rel + 32, len(body)), 4):
            wc = struct.unpack_from("<I", body, end_rel)[0]
            if (wc & 0xFFE0FC00) == 0x9A803000:  # csel xD, xN, xM, lo (cond=0011)
                rd = wc & 0x1F
                rn = (wc >> 5) & 0x1F
                rm = (wc >> 16) & 0x1F
                if rd == rn and rm == reg_lim:
                    hits.append((rel, end_rel + 4 - rel))
                    break
    return hits


def patch_gate3a_checkpoint(data, funcs, text_va, text_off, arch):
    if FUNC_CHECKPOINT not in funcs:
        raise PatchError(f"symbol not found: {FUNC_CHECKPOINT}")
    entryoff, size = funcs[FUNC_CHECKPOINT]
    if size == 0:
        size = 0x600
    fn_off = text_off + entryoff
    fn_va = text_va + entryoff
    body = bytes(data[fn_off:fn_off + size])

    if arch == "arm64":
        nop6 = NOP_ARM64 * 6
        idx = body.find(CLAMP_256K_ARM64)
        if idx >= 0:
            if body.find(CLAMP_256K_ARM64, idx + 1) >= 0:
                raise PatchError(f"{FUNC_CHECKPOINT}: multiple 256K clamps found")
            site = fn_off + idx
            data[site:site + 24] = nop6
            return True, (f"[Gate 3A] {FUNC_CHECKPOINT}: removed 256K (0x3e800) clamp "
                          f"@ {fn_va + idx:#x} (6x nop)")

        generic = _find_generic_arm64_256k_clamp(body)
        if len(generic) == 1:
            rel, length = generic[0]
            site = fn_off + rel
            data[site:site + length] = NOP_ARM64 * (length // 4)
            return True, (f"[Gate 3A] {FUNC_CHECKPOINT}: removed 256K (0x3e800) clamp "
                          f"@ {fn_va + rel:#x} ({length // 4}x nop)")

        if body.find(nop6) >= 0:
            return False, f"[Gate 3A] {FUNC_CHECKPOINT}: already patched"
        raise PatchError(f"{FUNC_CHECKPOINT}: 256K (0x3e800) clamp pattern not found")

    # x86-64
    idx = body.find(CLAMP_256K_X64)
    if idx >= 0:
        if body.find(CLAMP_256K_X64, idx + 1) >= 0:
            raise PatchError(f"{FUNC_CHECKPOINT}: multiple 256K clamps found")
        site = fn_off + idx
        data[site:site + len(PATCH_256K_X64)] = PATCH_256K_X64
        return True, (f"[Gate 3A] {FUNC_CHECKPOINT}: removed 256K (0x3e800) clamp "
                      f"@ {fn_va + idx:#x} (mov %edx,%esi + 12x nop)")

    if body.find(PATCH_256K_X64) >= 0:
        return False, f"[Gate 3A] {FUNC_CHECKPOINT}: already patched"
    raise PatchError(f"{FUNC_CHECKPOINT}: x86-64 256K (0x3e800) clamp pattern not found")


# --------------------------------------------------------------------------
# Gate 3B: config.applyFeatureProviderCheckpointOverrideConfig
#          prevent CASCADE_USE_EXPERIMENT_CHECKPOINTER from resetting 256K
# --------------------------------------------------------------------------

def patch_gate3b_exp_checkpoint(data, funcs, text_va, text_off, arch):
    if FUNC_EXP_CHECKPOINT not in funcs:
        raise PatchError(f"symbol not found: {FUNC_EXP_CHECKPOINT}")
    entryoff, size = funcs[FUNC_EXP_CHECKPOINT]
    if size == 0:
        size = 0x200
    fn_off = text_off + entryoff
    fn_va = text_va + entryoff
    body = bytes(data[fn_off:fn_off + size])

    if arch == "arm64":
        # Primary: clear expCp.MaxTokenLimit ([x0, #0xc] = 0) before MergeConfigsDedup
        for rel in range(4, len(body) - 16, 4):
            w_prev, w0, w1 = struct.unpack_from("<III", body, rel - 4)
            if (w_prev & 0xFC000000) != 0x94000000:
                continue
            if (w0 & 0xFF00001F) == 0xB4000000 and w1 == 0xB9000C1F:
                return False, f"[Gate 3B] {FUNC_EXP_CHECKPOINT}: already patched"
            if (w0 & 0xFF00001F) != 0xB4000001:  # cbz x1, <merge_prep>
                continue
            imm19 = (w0 >> 5) & 0x7FFFF
            if imm19 & 0x40000:
                imm19 -= 0x80000
            span = imm19 * 4
            if not (8 <= span <= 64 and rel + span + 8 <= len(body)):
                continue
            wm0, wm1 = struct.unpack_from("<II", body, rel + span)
            if (wm0 & 0xFFC003FF) == 0xF94003E1 and wm1 == 0xAA0003E2:
                cbz_x0 = w0 & 0xFFFFFFE0          # cbz x0, <merge_prep>
                str_wzr = 0xB9000C1F              # str wzr, [x0, #0xc]
                blob = (
                    struct.pack("<II", cbz_x0, str_wzr)
                    + NOP_ARM64 * ((span - 8) // 4)
                )
                data[fn_off + rel:fn_off + rel + span] = blob
                return True, (
                    f"[Gate 3B] {FUNC_EXP_CHECKPOINT}: zeroed expCp.MaxTokenLimit "
                    f"@ {fn_va + rel:#x} (cbz x0 + str wzr,[x0,#0xc])"
                )

        # Fallback: bypass HasFlag(expKey) branch after selectCheckpointExperimentKey
        if FUNC_SELECT_EXP_KEY in funcs:
            sel_va = text_va + funcs[FUNC_SELECT_EXP_KEY][0]
            for rel in range(0, len(body) - 16, 4):
                w = struct.unpack_from("<I", body, rel)[0]
                if decode_bl_target(fn_va + rel, w) != sel_va:
                    continue
                for scan in range(rel + 4, min(rel + 72, len(body) - 4), 4):
                    wb, wn = struct.unpack_from("<II", body, scan)
                    if (wb & 0xFFFFFC1F) != 0xD63F0000:  # blr xR
                        continue
                    if wn == 0xD503201F:
                        return False, f"[Gate 3B] {FUNC_EXP_CHECKPOINT}: already patched"
                    if (wn & 0xFFFE001F) == 0x37000000 or (wn & 0x7F00001F) == 0x35000000:
                        data[fn_off + scan + 4:fn_off + scan + 8] = NOP_ARM64
                        return True, (
                            f"[Gate 3B] {FUNC_EXP_CHECKPOINT}: bypassed HasFlag "
                            f"override @ {fn_va + scan + 4:#x}"
                        )
        raise PatchError(f"{FUNC_EXP_CHECKPOINT}: arm64 override site not found")

    # x86-64: bypass HasFlag(expKey) `test %al,%al ; jne ...` after selectCheckpointExperimentKey
    if FUNC_SELECT_EXP_KEY not in funcs:
        raise PatchError(f"symbol not found: {FUNC_SELECT_EXP_KEY}")
    sel_va = text_va + funcs[FUNC_SELECT_EXP_KEY][0]
    for rel in range(0, len(body) - 12):
        if body[rel] != 0xE8:
            continue
        disp = struct.unpack_from("<i", body, rel + 1)[0]
        if fn_va + rel + 5 + disp != sel_va:
            continue
        window = body[rel + 5:min(len(body), rel + 105)]
        t_idx = window.find(b"\x84\xc0")  # test %al, %al
        if t_idx < 0:
            continue
        j_off = rel + 5 + t_idx + 2
        if body[j_off:j_off + 2] == b"\x90\x90":
            return False, f"[Gate 3B] {FUNC_EXP_CHECKPOINT}: already patched"
        if body[j_off] == 0x75:  # jne rel8
            data[fn_off + j_off:fn_off + j_off + 2] = b"\x90\x90"
            return True, (f"[Gate 3B] {FUNC_EXP_CHECKPOINT}: bypassed HasFlag "
                          f"override @ {fn_va + j_off:#x} (2x nop)")
        if body[j_off:j_off + 2] == b"\x0f\x85":  # jne rel32
            data[fn_off + j_off:fn_off + j_off + 6] = b"\x90" * 6
            return True, (f"[Gate 3B] {FUNC_EXP_CHECKPOINT}: bypassed HasFlag "
                          f"override @ {fn_va + j_off:#x} (6x nop)")
    raise PatchError(f"{FUNC_EXP_CHECKPOINT}: x86-64 override site not found")


# --------------------------------------------------------------------------
# Gate 4A: chatconverters.(*TrajectoryChatConverter).getMaxTokensForStep
#          disable the 64K per-USER_INPUT-step token clamp
# --------------------------------------------------------------------------

def _decode_imm19(word):
    imm = (word >> 5) & 0x7FFFF
    return imm - 0x80000 if imm & 0x40000 else imm


def _scan_arm64_step_dispatch(body):
    """Find `cmp w0,#8 ; b.eq ; cmp w0,#0x13 ; b.ne <non_user>`.

    Returns (bne_rel, non_user_rel) or None.
    """
    for rel in range(0, max(0, len(body) - 16), 4):
        w_cmp8, w_beq, w_cmp19, w_bne = struct.unpack_from("<IIII", body, rel)
        if w_cmp8 != 0x7100201F or w_cmp19 != 0x71004C1F:
            continue
        if (w_beq & 0xFF00001F) != 0x54000000:   # b.eq
            continue
        if (w_bne & 0xFF00001F) != 0x54000001:   # b.ne
            continue
        bne_rel = rel + 12
        return bne_rel, bne_rel + _decode_imm19(w_bne) * 4
    return None


def _x86_step_dispatch(body):
    """Find `cmp $0x8,%eax` ... `cmp $0x13,%eax` ; jne <non_user>.

    Returns (jne_end_rel, non_user_rel) or None.
    """
    for rel in range(0, max(0, len(body) - 24)):
        if body[rel:rel + 3] != b"\x83\xf8\x08":
            continue
        i19 = body.find(b"\x83\xf8\x13", rel + 3, rel + 19)
        if i19 < 0:
            continue
        j = i19 + 3
        if body[j] == 0x75 and j + 2 <= len(body):          # jne rel8
            target = j + 2 + struct.unpack_from("<b", body, j + 1)[0]
            return j + 2, target
        if body[j:j + 2] == b"\x0f\x85" and j + 6 <= len(body):  # jne rel32
            target = j + 6 + struct.unpack_from("<i", body, j + 2)[0]
            return j + 6, target
    return None


def _x86_find_epilogue(body, start):
    """Locate `add $imm,%rsp ; pop %rbp ; ret` or `leave ; ret` at/after `start`.

    Returns (jump_rel, end_rel) where jump_rel is the stack-dealloc site
    (or the `pop %rbp` / `leave` site when no `add` precedes it), or None.
    """
    window_end = min(len(body), start + 64)
    pop = body.find(b"\x5d\xc3", start, window_end)
    leave = body.find(b"\xc9\xc3", start, window_end)
    if leave >= 0 and (pop < 0 or leave < pop):
        return leave, leave
    if pop < 4:
        return None
    add = None
    for rel in range(max(0, pop - 16), pop - 2):
        if body[rel:rel + 3] == b"\x48\x83\xc4":       # add $imm8, %rsp
            add = rel
        elif body[rel:rel + 3] == b"\x48\x81\xc4":     # add $imm32, %rsp
            add = rel
    return (add if add is not None else pop), pop


def patch_gate4a_user_input_step(data, funcs, text_va, text_off, arch):
    if FUNC_MAX_STEP_TOKENS not in funcs:
        raise PatchError(f"symbol not found: {FUNC_MAX_STEP_TOKENS}")
    entryoff, size = funcs[FUNC_MAX_STEP_TOKENS]
    if size == 0:
        size = 0x100
    fn_off = text_off + entryoff
    fn_va = text_va + entryoff
    body = bytes(data[fn_off:fn_off + size])

    if arch == "arm64":
        found = _scan_arm64_step_dispatch(body)
        if found is None:
            raise PatchError(f"{FUNC_MAX_STEP_TOKENS}: arm64 step-type dispatch not found")
        bne_rel, non_user_rel = found
        if not 0 < non_user_rel <= len(body) - 8:
            raise PatchError(f"{FUNC_MAX_STEP_TOKENS}: arm64 b.ne target out of range")
        if struct.unpack_from("<I", body, non_user_rel + 4)[0] != MOV_X0_X2:
            raise PatchError(f"{FUNC_MAX_STEP_TOKENS}: arm64 non-user branch "
                             f"does not end in `mov x0, x2`")

        epi_mov_va = fn_va + non_user_rel + 4
        patch_rel = bne_rel + 4
        patch_va = fn_va + patch_rel
        blob = struct.pack("<II", MOV_X2_XZR, encode_b(patch_va + 4, epi_mov_va))

        if body[patch_rel:patch_rel + 8] == blob:
            return False, f"[Gate 4A] {FUNC_MAX_STEP_TOKENS}: already patched"

        data[fn_off + patch_rel:fn_off + patch_rel + 8] = blob
        return True, (f"[Gate 4A] {FUNC_MAX_STEP_TOKENS}: disabled 64K USER_INPUT "
                      f"step clamp @ {patch_va:#x} (mov x2,xzr ; b epilogue)")

    found = _x86_step_dispatch(body)
    if found is None:
        raise PatchError(f"{FUNC_MAX_STEP_TOKENS}: x86-64 step-type dispatch not found")
    user_rel, non_user_rel = found
    if not 0 < non_user_rel <= len(body) - 1:
        raise PatchError(f"{FUNC_MAX_STEP_TOKENS}: x86-64 jne target out of range")

    epi = _x86_find_epilogue(body, non_user_rel)
    if epi is None:
        raise PatchError(f"{FUNC_MAX_STEP_TOKENS}: x86-64 epilogue not found")
    jump_rel, _pop_rel = epi

    patch_va = fn_va + user_rel
    rel32 = (fn_va + jump_rel) - (patch_va + 7)
    if not -(1 << 31) <= rel32 < (1 << 31):
        raise PatchError(f"{FUNC_MAX_STEP_TOKENS}: x86-64 epilogue jump out of range")
    blob = X64_ZERO_EAX + b"\xe9" + struct.pack("<i", rel32)

    if body[user_rel:user_rel + len(blob)] == blob:
        return False, f"[Gate 4A] {FUNC_MAX_STEP_TOKENS}: already patched"

    data[fn_off + user_rel:fn_off + user_rel + len(blob)] = blob
    return True, (f"[Gate 4A] {FUNC_MAX_STEP_TOKENS}: disabled 64K USER_INPUT "
                  f"step clamp @ {patch_va:#x} (xor eax,eax ; jmp epilogue)")


# --------------------------------------------------------------------------
# Gate 4B: serializers.DefaultSerializer.stepToMessage (OneHarness, agy >= 1.5.0)
#          route STEP_TYPE_USER_INPUT to the zero-token-limit branch
# --------------------------------------------------------------------------

def _scan_oneharness_arm64(body):
    """Find `cmp wR,#0xe ; b.eq ; cmp wR,#0x17 ; b.ne ; mov xM,xzr`.

    Returns (beq_rel, beq_word) or None.
    """
    for rel in range(0, max(0, len(body) - 16), 4):
        w0, w1, w2, w3, w4 = struct.unpack_from("<IIIII", body, rel)
        if (w0 & 0xFFFFFC1F) != 0x7100381F:      # cmp wR, #0xe
            continue
        if (w1 & 0xFF00001F) != 0x54000000:      # b.eq
            continue
        if w1 not in (ONEHARNESS_BEQ_WORD, ONEHARNESS_BEQ_PATCHED):
            continue
        if w2 != (0x71005C1F | (w0 & 0x03E0)):   # cmp wR, #0x17 (same reg)
            continue
        if (w3 & 0xFF00001F) != 0x54000001:      # b.ne
            continue
        if (w4 & 0xFFFFFFE0) != 0xAA1F03E0:      # mov xM, xzr @ rel+16
            continue
        return rel + 4, w1
    return None


def _x86_match_cmp_imm8(body, pos, rex, modrm, imm8):
    n = len(body)
    if rex is not None:
        if pos + 4 <= n and body[pos] == rex and body[pos + 1] == 0x83 and body[pos + 2] == modrm and body[pos + 3] == imm8:
            return pos + 4
        return None
    if pos + 3 <= n and body[pos] == 0x83 and body[pos + 1] == modrm and body[pos + 2] == imm8:
        return pos + 3
    return None


def _x86_zero_insn_len(body, pos):
    """Return byte length (2 or 3) of `xor %r32,%r32` at `pos`, else 0."""
    n = len(body)
    if pos + 2 <= n and body[pos] == 0x31:
        modrm = body[pos + 1]
        if modrm >> 6 == 3 and (modrm >> 3) & 7 == modrm & 7:
            return 2
    if pos + 3 <= n and body[pos] == 0x45 and body[pos + 1] == 0x31:
        modrm = body[pos + 2]
        if modrm >> 6 == 3 and (modrm >> 3) & 7 == modrm & 7:
            return 3
    return 0


def _x86_find_zeroing_xor(body, start):
    """Locate `xor %r32,%r32` (or `45 31 ..` r8d-r15d form) at/after `start`."""
    n = len(body)
    for rel in range(start, min(n - 2, start + 48)):
        if _x86_zero_insn_len(body, rel) > 0:
            return rel
    return None


def _scan_oneharness_x86(body):
    """Find the OneHarness `0xe` / `0x17` step-type dispatch in x86-64 code.

    Supports both compiler branch layouts:
      - ("je", je_rel, zero_rel):
            cmp $0xe,%r32 ; je <64k> ; cmp $0x17,%r32 ; jne <16k> ; xor %rDst,%rDst
      - ("jne_fallthrough", fall_start, patched_fall):
            cmp $0xe,%r32 ; jne <c17> ; <load 64k> ; jmp <merge>
        c17:cmp $0x17,%r32 ; jne <16k> ; xor %rDst,%rDst ; jmp <merge>
    """
    n = len(body)
    for rel in range(0, max(0, n - 16)):
        if body[rel] == 0x83:
            rex, modrm, c0, br_rel = None, body[rel + 1], rel, rel + 3
        elif body[rel] == 0x41 and rel + 4 < n and body[rel + 1] == 0x83:
            rex, modrm, c0, br_rel = 0x41, body[rel + 2], rel + 1, rel + 4
        else:
            continue
        if not 0xF8 <= modrm <= 0xFF or body[c0 + 2] != 0x0E or br_rel + 1 >= n:
            continue

        op = body[br_rel]
        if op == 0x74:  # je rel8
            jne = _x86_match_cmp_imm8(body, br_rel + 2, rex, modrm, 0x17)
            if jne is None or jne + 1 >= n or body[jne] != 0x75:
                continue
            zero_rel = _x86_find_zeroing_xor(body, jne + 2)
            if zero_rel is not None:
                return ("je", br_rel, zero_rel)

        elif op == 0x75:  # jne rel8 (Go 1.24+ x86-64 fallthrough layout)
            disp0 = body[br_rel + 1]
            if not 4 <= disp0 <= 32:
                continue
            fall_start = br_rel + 2
            c17 = fall_start + disp0
            if c17 > n or body[c17 - 2] != 0xEB:  # fallthrough ends in jmp rel8
                continue
            merge_from_0e = c17 + struct.unpack_from("<b", body, c17 - 1)[0]
            jne = _x86_match_cmp_imm8(body, c17, rex, modrm, 0x17)
            if jne is None or jne + 1 >= n or body[jne] != 0x75:
                continue
            zero_rel = jne + 2
            zlen = _x86_zero_insn_len(body, zero_rel)
            jmp17 = zero_rel + zlen
            if zlen == 0 or jmp17 + 1 >= n or body[jmp17] != 0xEB:
                continue
            merge_from_17 = (jmp17 + 2) + struct.unpack_from("<b", body, jmp17 + 1)[0]
            slot_len = (c17 - 2) - fall_start
            if merge_from_0e != merge_from_17 or slot_len < zlen:
                continue
            patched_fall = body[zero_rel:zero_rel + zlen] + (b"\x90" * (slot_len - zlen))
            return ("jne_fallthrough", fall_start, patched_fall)
    return None


def patch_gate4b_oneharness_user_input(data, funcs, text_va, text_off, arch):
    if FUNC_ONEHARNESS_STEP not in funcs:
        return False, (f"[Gate 4B] {FUNC_ONEHARNESS_STEP}: not present "
                       f"(pre-1.5 binary), skipped")
    entryoff, size = funcs[FUNC_ONEHARNESS_STEP]
    if size == 0:
        size = 0x100
    fn_off = text_off + entryoff
    fn_va = text_va + entryoff
    body = bytes(data[fn_off:fn_off + size])

    if arch == "arm64":
        found = _scan_oneharness_arm64(body)
        if found is None:
            raise PatchError(f"{FUNC_ONEHARNESS_STEP}: arm64 OneHarness step "
                             f"dispatch not found")
        beq_rel, beq_word = found
        if beq_word == ONEHARNESS_BEQ_PATCHED:
            return False, f"[Gate 4B] {FUNC_ONEHARNESS_STEP}: already patched"
        struct.pack_into("<I", data, fn_off + beq_rel, ONEHARNESS_BEQ_PATCHED)
        return True, (f"[Gate 4B] {FUNC_ONEHARNESS_STEP}: routed "
                      f"STEP_TYPE_USER_INPUT (0xe) to zero limit "
                      f"@ {fn_va + beq_rel:#x}")

    found = _scan_oneharness_x86(body)
    if found is None:
        raise PatchError(f"{FUNC_ONEHARNESS_STEP}: x86-64 OneHarness step "
                         f"dispatch not found")
    if found[0] == "jne_fallthrough":
        _, fall_start, patched_fall = found
        end = fall_start + len(patched_fall)
        if body[fall_start:end] == patched_fall:
            return False, f"[Gate 4B] {FUNC_ONEHARNESS_STEP}: already patched"
        data[fn_off + fall_start:fn_off + end] = patched_fall
        return True, (f"[Gate 4B] {FUNC_ONEHARNESS_STEP}: routed "
                      f"STEP_TYPE_USER_INPUT (0xe) to zero limit "
                      f"@ {fn_va + fall_start:#x}")

    _, je_rel, zero_rel = found
    patched_disp = zero_rel - (je_rel + 2)
    if not 0 <= patched_disp <= 0x7F:
        raise PatchError(f"{FUNC_ONEHARNESS_STEP}: x86-64 je target out of range")
    if body[je_rel + 1] == patched_disp:
        return False, f"[Gate 4B] {FUNC_ONEHARNESS_STEP}: already patched"
    data[fn_off + je_rel + 1] = patched_disp
    return True, (f"[Gate 4B] {FUNC_ONEHARNESS_STEP}: routed "
                  f"STEP_TYPE_USER_INPUT (0xe) to zero limit "
                  f"@ {fn_va + je_rel:#x}")


# --------------------------------------------------------------------------
# Bonus Patch 4 (arm64 optional): restore AGY_CLI_AUTO_COMPACT_OVERRIDE
# --------------------------------------------------------------------------

def patch_env(data, funcs, text_va, text_off, arch):
    if arch != "arm64":
        raise PatchError("env-var restore is arm64-only")
    for needed in (FUNC_OVERRIDE, "strings.TrimSpace", "os.Getenv"):
        if needed not in funcs:
            raise PatchError(f"symbol not found: {needed}")

    entryoff, size = funcs[FUNC_OVERRIDE]
    start = text_off + entryoff
    body = bytes(data[start:start + (size or 512)])

    name_off = data.find(ENV_NAME)
    if name_off < 0:
        raise PatchError("env var string missing from rodata")
    target = text_va - text_off + name_off
    site_va = text_va + entryoff

    hits = [m.start() for m in re.finditer(re.escape(GETENV_STUB_ARM64), body)]
    if len(hits) != 1:
        # Check if `bl os.Getenv` is already wired inside store.AutoCompactOverride
        getenv_va = text_va + funcs["os.Getenv"][0]
        for rel in range(0, len(body) - 4, 4):
            w = struct.unpack_from("<I", body, rel)[0]
            if decode_bl_target(site_va + rel, w) == getenv_va:
                return False, f"[EnvFix] {FUNC_OVERRIDE}: already patched"
        raise PatchError(f"{FUNC_OVERRIDE}: expected 1 folded Getenv stub, found {len(hits)}")

    site = start + hits[0]
    bl_site = site + 12
    old_bl = struct.unpack_from("<I", data, bl_site)[0]
    bl_pc = site_va + hits[0] + 12
    trim_va = text_va + funcs["strings.TrimSpace"][0]
    if decode_bl_target(bl_pc, old_bl) != trim_va:
        raise PatchError("stub bl does not target strings.TrimSpace")

    words = (
        encode_adrp(0, site_va + hits[0], target),
        encode_add_imm(0, 0, target & 0xFFF),
        encode_movz64(1, len(ENV_NAME)),
        encode_bl(bl_pc, text_va + funcs["os.Getenv"][0]),
    )
    data[site:site + 16] = b"".join(struct.pack("<I", w) for w in words)
    return True, (f"[EnvFix] {FUNC_OVERRIDE}: restored {ENV_NAME.decode()} "
                  f"(strings.TrimSpace -> os.Getenv @ {bl_pc:#x})")


# --------------------------------------------------------------------------
# Signing & atomic write
# --------------------------------------------------------------------------

def _extract_adhoc_safe_entitlements(src_path):
    """Read existing Mach-O entitlements (e.g. allow-jit) safe for ad-hoc signing."""
    if sys.platform != "darwin" or not os.path.exists(src_path):
        return None
    res = subprocess.run(
        ["codesign", "-d", "--entitlements", ":-", src_path],
        capture_output=True,
    )
    if res.returncode != 0 or not res.stdout.strip().startswith(b"<?xml"):
        return None
    try:
        ent = plistlib.loads(res.stdout)
    except Exception:
        return None
    if not isinstance(ent, dict):
        return None
    filtered = {
        k: v for k, v in ent.items()
        if not k.startswith("com.apple.developer.")
        and k not in ("keychain-access-groups", "com.apple.application-identifier")
    }
    return plistlib.dumps(filtered) if filtered else None


def _extract_identifier(src_path):
    """Read the existing code-signing identifier (defaults to file basename).

    Signing the temp copy would otherwise bake in "<name>.tmp.<pid>" as the
    identifier, which changes the code identity that TCC and the keychain
    bind to (the desktop backend is signed as "language_server", not
    "language_server.tmp.35559").
    """
    if sys.platform != "darwin" or not os.path.exists(src_path):
        return None
    res = subprocess.run(["codesign", "-d", "--verbose=2", src_path],
                         capture_output=True, text=True)
    # codesign writes its description to stderr.
    m = re.search(r"^Identifier=(.+)$", res.stderr or res.stdout, re.M)
    return m.group(1).strip() if m else None


def resign(path, entitlements_xml=None, identifier=None):
    if sys.platform != "darwin":
        print("[i] non-macOS host: skipping codesign")
        return
    ent_file = None
    try:
        cmd = ["codesign", "--force", "--sign", "-", "--options", "runtime"]
        if identifier:
            cmd.extend(["--identifier", identifier])
        if entitlements_xml:
            fd, ent_file = tempfile.mkstemp(suffix=".entitlements.plist")
            os.write(fd, entitlements_xml)
            os.close(fd)
            cmd.extend(["--entitlements", ent_file])
        cmd.append(path)
        subprocess.run(cmd, check=True, capture_output=True)
        subprocess.run(
            ["codesign", "--verify", "--verbose=1", path],
            check=True,
            capture_output=True,
        )
    finally:
        if ent_file and os.path.exists(ent_file):
            os.unlink(ent_file)


def _strip_pe_authenticode(data):
    """Clear PE CheckSum and trailing Authenticode Certificate Table after patching."""
    if data[:2] != b"MZ":
        return
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if pe + 24 > len(data) or data[pe:pe + 4] != b"PE\0\0":
        return
    opt = pe + 24
    magic = struct.unpack_from("<H", data, opt)[0]
    dd_sec = opt + (144 if magic == 0x20B else 128 if magic == 0x10B else 0)
    if dd_sec == 0 or dd_sec + 8 > len(data):
        return
    struct.pack_into("<I", data, opt + 64, 0)
    cert_off, cert_size = struct.unpack_from("<II", data, dd_sec)
    if cert_off > 0 and cert_size > 0:
        struct.pack_into("<II", data, dd_sec, 0, 0)
        if cert_off + cert_size == len(data):
            del data[cert_off:]


def _default_binary_path():
    if sys.platform == "win32":
        local_app = os.environ.get("LOCALAPPDATA") or os.path.join(
            os.path.expanduser("~"), "AppData", "Local"
        )
        return os.path.join(local_app, "agy", "bin", "agy.exe")
    return os.path.expanduser("~/.local/bin/agy")


def _running_pids_for_binary(src):
    if sys.platform == "win32":
        exe_name = os.path.basename(src)
        res = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {exe_name}", "/NH", "/FO", "CSV"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        pids = []
        for line in res.stdout.splitlines():
            parts = [p.strip('"') for p in line.split('","')]
            if len(parts) >= 2 and parts[0].lower() == exe_name.lower() and parts[1].isdigit():
                pids.append(parts[1])
        return pids
    running = subprocess.run(["pgrep", "-f", src], capture_output=True, text=True)
    return [p for p in running.stdout.split() if p != str(os.getpid())]


def write_atomic_signed(dst, data, src_for_entitlements=None, make_backup=False):
    """Write to a fresh inode, sign, then os.replace() to refresh macOS cs_blob cache."""
    _strip_pe_authenticode(data)
    ent_xml = _extract_adhoc_safe_entitlements(src_for_entitlements or dst)
    ident = _extract_identifier(src_for_entitlements or dst)
    if make_backup and os.path.exists(dst):
        bak = dst + ".bak"
        if not os.path.exists(bak):
            shutil.copy2(dst, bak)
            print(f"[i] saved backup: {bak}")

    tmp = f"{dst}.tmp.{os.getpid()}"
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.chmod(tmp, 0o755)
        resign(tmp, entitlements_xml=ent_xml, identifier=ident)
        try:
            os.replace(tmp, dst)
        except PermissionError as exc:
            raise PatchError(
                f"cannot overwrite {dst} ({exc.strerror or 'access denied'}); "
                f"quit any running {os.path.basename(dst)} processes and retry"
            ) from exc
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise

    if ident:
        print(f"[i] signature: identifier preserved as {ident!r}")
    if sys.platform == "darwin" and ".app/Contents/" in dst:
        print("[!] target lives inside an .app bundle: the bundle's sealed "
              "resources no longer verify\n"
              "    (codesign --verify --deep <app> now fails; the app still "
              "launches, at your own risk).")
        if os.path.exists(dst + ".bak"):
            print(f"    restore: cp -p '{dst}.bak' '{dst}'")


def main():
    for stream in (sys.stdout, sys.stderr):
        reconf = getattr(stream, "reconfigure", None)
        if callable(reconf):
            reconf(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(
        description="Unlock all context-window gates (4A/4B) in the agy CLI."
    )
    ap.add_argument("--binary", default=_default_binary_path())
    ap.add_argument("--no-env-fix", action="store_true",
                    help="skip optional AGY_CLI_AUTO_COMPACT_OVERRIDE restore")
    ap.add_argument("--no-backup", action="store_true",
                    help="skip creating <binary>.bak on --in-place")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--in-place", action="store_true")
    ap.add_argument("--locate", action="store_true", help="print target symbols only")
    args = ap.parse_args()

    src = os.path.abspath(os.path.expanduser(args.binary))
    if not os.path.exists(src):
        sys.exit(f"error: no such file: {src}")

    with open(src, "rb") as fh:
        data = bytearray(fh.read())
    before = hashlib.sha256(data).hexdigest()

    pids = _running_pids_for_binary(src)
    if pids:
        print(f"[!] {len(pids)} process(es) are running this binary "
              f"(pid {', '.join(pids[:5])}); quit them first or replacing / "
              f"reloading the binary may fail")

    text_va, text_off, arch = find_text_section(data)
    funcs = build_functions(bytes(data))
    print(f"[i] binary : {src}")
    print(f"[i] target : arch={arch} text_va={text_va:#x} text_off={text_off:#x} "
          f"symbols={len(funcs)}")

    inspect_syms = (
        FUNC_OFFERS,
        FUNC_STORE_CW,
        FUNC_STORE_CHOICE,
        FUNC_CHECKPOINT,
        FUNC_EXP_CHECKPOINT,
        FUNC_MAX_STEP_TOKENS,
        FUNC_ONEHARNESS_STEP,
        FUNC_OVERRIDE,
        "strings.TrimSpace",
        "os.Getenv",
    )
    for key in inspect_syms:
        if key in funcs:
            eoff, sz = funcs[key]
            print(f"[i] symbol : {key} -> {text_va + eoff:#x} (size={sz:#x})")
        else:
            print(f"[i] symbol : {key} -> MISSING")

    if args.locate:
        return

    is_server_only = (FUNC_OFFERS not in funcs and FUNC_STORE_CW not in funcs)
    base_lower = os.path.basename(src).lower()
    if is_server_only and (base_lower == "agy" or base_lower.startswith("agy.")):
        raise PatchError(
            f"{src} is missing CLI context-window symbols (outdated agy < 1.4); "
            f"upgrade first with `agy update` or reinstall from "
            f"https://antigravity.google/docs/install?tab=cli"
        )
    if is_server_only:
        print("[i] mode   : standalone language_server (Gate 3A/3B + Gate 4A/4B)")
        patch_pipeline = (
            patch_gate3a_checkpoint,
            patch_gate3b_exp_checkpoint,
            patch_gate4a_user_input_step,
            patch_gate4b_oneharness_user_input,
        )
    else:
        patch_pipeline = (
            patch_gate1_ui,
            patch_gate2_store,
            patch_gate3a_checkpoint,
            patch_gate3b_exp_checkpoint,
            patch_gate4a_user_input_step,
            patch_gate4b_oneharness_user_input,
        )

    for patch_fn in patch_pipeline:
        changed, msg = patch_fn(data, funcs, text_va, text_off, arch)
        print(("[*] " if changed else "[=] ") + msg)

    if not is_server_only and not args.no_env_fix:
        try:
            changed, msg = patch_env(data, funcs, text_va, text_off, arch)
            print(("[*] " if changed else "[=] ") + msg)
        except PatchError as exc:
            print(f"[!] skipped optional env-var patch: {exc}")

    after = hashlib.sha256(bytes(data)).hexdigest()
    if before == after:
        print("[=] all gates already unlocked; nothing to write")
        return
    if args.dry_run:
        print(f"[*] dry run complete: sha256 {before[:12]} -> {after[:12]}")
        return

    dst = src if args.in_place else src + ".patched"
    write_atomic_signed(
        dst,
        data,
        src_for_entitlements=src,
        make_backup=(args.in_place and not args.no_backup),
    )
    final_sha = hashlib.sha256(open(dst, "rb").read()).hexdigest()
    print(f"[*] wrote  : {dst}\n    sha256 : {before[:12]} -> {final_sha[:12]}")


if __name__ == "__main__":
    try:
        main()
    except PatchError as exc:
        sys.exit(f"error: {exc}")
