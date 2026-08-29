'use strict';

/**
 * 把抖音 detail 接口的原始 JSON 清洗成结构化结果。
 *
 * 与外部版（去水印）的区别：这里只关心「把真实的媒体地址找出来」，
 * 不做水印处理，主地址一律取画质最高的那个。
 */

const MAX_ALTERNATIVES = 5; // 备选清晰度上限，避免返回一堆重复档位

/** 从 detail 响应体里尽可能找到 aweme_detail 本体 */
function findDetail(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.aweme_detail) return payload.aweme_detail;
  if (Array.isArray(payload.aweme_list) && payload.aweme_list.length) return payload.aweme_list[0];
  if (Array.isArray(payload.data) && payload.data.length) return payload.data[0];
  if (payload.data && payload.data.aweme_detail) return payload.data.aweme_detail;
  if (payload.item_list && payload.item_list.length) return payload.item_list[0];
  for (const v of Object.values(payload)) {
    if (v && typeof v === 'object' && v.aweme_id) return v;
  }
  return null;
}

function firstUrl(node) {
  if (!node) return null;
  if (typeof node === 'string') return node;
  const lists = [node.url_list, node.download_url_list];
  for (const list of lists) {
    if (Array.isArray(list)) {
      const u = list.find((x) => typeof x === 'string' && x.startsWith('http'));
      if (u) return u;
    }
  }
  return null;
}

function pickUrls(node) {
  if (!node || !Array.isArray(node.url_list)) return [];
  return node.url_list.filter((x) => typeof x === 'string' && x.startsWith('http'));
}

/**
 * 收集视频地址候选。
 * 同一份视频在 url_list 里有多个 CDN 镜像，只取第一个，否则会刷屏重复。
 * @returns {Array<{url,label,width,height,size,source}>}
 */
function videoCandidates(detail) {
  const v = detail.video || {};
  const out = [];
  const seenUrl = new Set();
  const seenGear = new Set();

  function push(url, label, source, w, h, size) {
    if (!url || seenUrl.has(url)) return;
    seenUrl.add(url);
    out.push({
      url,
      label,
      width: w || null,
      height: h || null,
      size: size || null,
      source,
    });
  }

  function mainUrl(node) {
    const list = pickUrls(node);
    return list.length ? list[0] : null;
  }

  // 主播放地址（画质最高）
  const pa = v.play_addr || {};
  const paUrl = mainUrl(pa);
  if (paUrl) {
    push(paUrl, '默认', 'play_addr', pa.width || v.width, pa.height || v.height, pa.data_size);
  }

  // 不同编码的变体
  [['play_addr_h264', 'H.264'], ['play_addr_265', 'H.265']].forEach(([key, tag]) => {
    const node = v[key];
    if (!node) return;
    const u = mainUrl(node);
    if (u) push(u, tag, key, node.width, node.height, node.data_size);
  });

  // 多清晰度档位：按分辨率降序去重
  const bitrate = (Array.isArray(v.bit_rate) ? v.bit_rate : [])
    .map((b) => {
      const addr = b.play_addr || {};
      const url = mainUrl(addr);
      if (!url) return null;
      return {
        url,
        gear: b.gear_name || b.quality_type || '',
        w: addr.width || b.width || 0,
        h: addr.height || b.height || 0,
        size: addr.data_size || b.data_size || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.h - a.h || b.w - a.w || (b.size || 0) - (a.size || 0));

  for (const b of bitrate) {
    const key = `${b.gear}|${b.w}x${b.h}`;
    if (seenGear.has(key)) continue;
    seenGear.add(key);
    if (out.length >= MAX_ALTERNATIVES) break;
    push(b.url, b.gear || '默认', 'bit_rate', b.w, b.h, b.size);
  }

  // 排序：分辨率高的在前，同分辨率体积大的在前（码率更高）
  out.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.size || 0) - (a.size || 0));
  return out;
}

/** 图集：返回所有图片原图 */
function imageCandidates(detail) {
  const list = detail.image_list || [];
  return list
    .map((img, i) => {
      const url = firstUrl(img) || firstUrl(img.origin_cover) || firstUrl(img.thumbnail);
      return url ? { url, label: `图 ${i + 1}`, index: i } : null;
    })
    .filter(Boolean);
}

function musicInfo(detail) {
  const m = detail.music;
  if (!m) return null;
  return {
    id: m.id_str || (m.id != null ? String(m.id) : null),
    title: m.title || '',
    author: m.author || '',
    duration: m.duration != null ? m.duration : null,
    cover: firstUrl(m.cover_hd) || firstUrl(m.cover_large) || firstUrl(m.cover_thumb),
    playUrl: firstUrl(m.play_url) || firstUrl(m.download_url),
  };
}

/** 主清洗入口 */
function normalize(payload, extra = {}) {
  const detail = findDetail(payload);
  if (!detail) return null;

  const author = detail.author || {};
  const st = detail.statistics || detail.stats || {};
  const v = detail.video || {};
  const durationMs = v.duration || detail.duration || null;

  const images = imageCandidates(detail);
  const videos = videoCandidates(detail);
  const type = videos.length ? 'video' : images.length ? 'images' : 'unknown';

  // 话题标签
  const tags = [];
  for (const t of detail.text_extra || []) {
    if (t.hashtag_name && !tags.includes(t.hashtag_name)) tags.push(t.hashtag_name);
  }
  if (!tags.length && Array.isArray(detail.cha_list)) {
    for (const c of detail.cha_list) if (c.cha_name) tags.push(c.cha_name);
  }

  const cover =
    firstUrl(v.origin_cover) ||
    firstUrl(v.cover) ||
    firstUrl(detail.origin_cover) ||
    firstUrl(detail.cover) ||
    (images[0] && images[0].url) ||
    null;

  return {
    type,
    awemeId: detail.aweme_id || detail.awemeid || extra.awemeId || null,
    title: detail.desc || detail.title || '',
    desc: detail.desc || '',
    createTime: detail.create_time || null,
    createTimeText: detail.create_time
      ? new Date(detail.create_time * 1000).toISOString().replace('T', ' ').slice(0, 19)
      : null,
    duration: durationMs != null ? Math.round(durationMs / 1000) : null,
    cover,
    author: {
      uid: author.uid || null,
      secUid: author.sec_uid || null,
      nickname: author.nickname || '',
      verify: author.enterprise_verify_reason || author.custom_verify || '',
      avatar: firstUrl(author.avatar_larger) || firstUrl(author.avatar_thumb) || null,
    },
    stats: {
      digg: st.digg_count != null ? st.digg_count : null,
      comment: st.comment_count != null ? st.comment_count : null,
      collect: st.collect_count != null ? st.collect_count : null,
      share: st.share_count != null ? st.share_count : null,
      play: st.play_count ? st.play_count : null,
    },
    music: musicInfo(detail),
    tags,
    /** 媒体地址：primary 是推荐的主地址，其余放 alternatives */
    media: {
      primary: videos[0] || null,
      alternatives: videos.slice(1),
      images,
    },
    meta: {
      source: extra.source || null,
      resolvedUrl: extra.resolvedUrl || null,
      steps: extra.steps || [],
    },
  };
}

module.exports = { normalize, findDetail, videoCandidates, imageCandidates, firstUrl };
