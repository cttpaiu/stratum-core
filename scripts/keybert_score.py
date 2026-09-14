#!/usr/bin/env python3
"""KeyBERT Semantic Re-Ranking for Stratum TF-IDF extraction."""
import sys
import json

def compute_keybert_scores(docs, candidates, model_name="allenai-specter", alpha=0.1):
    try:
        from sentence_transformers import SentenceTransformer, util
    except ImportError:
        # Fallback to pure TF-IDF if sentence_transformers is not available
        return candidates

    model = SentenceTransformer(model_name)

    candidate_terms = [c["term"] for c in candidates]
    candidate_lower = [c.lower() for c in candidate_terms]
    term_scores = {t: [] for t in candidate_terms}

    candidate_embeddings = model.encode(candidate_terms, show_progress_bar=False, convert_to_tensor=True)
    doc_embeddings = model.encode(docs, show_progress_bar=False, convert_to_tensor=True, batch_size=32)

    for doc, doc_emb in zip(docs, doc_embeddings):
        doc_lower = doc.lower()
        present_idx = [i for i, c in enumerate(candidate_lower) if c in doc_lower]
        if not present_idx:
            continue
        sims = util.cos_sim(doc_emb, candidate_embeddings[present_idx])[0].tolist()
        for idx, sim in zip(present_idx, sims):
            term_scores[candidate_terms[idx]].append(sim)

    kb_scores = {t: (sum(s) / len(s) if s else 0.0) for t, s in term_scores.items()}

    # Min-max normalization & blending
    tfidf_vals = [c["score"] for c in candidates]
    lo_tf, hi_tf = (min(tfidf_vals), max(tfidf_vals)) if tfidf_vals else (0.0, 1.0)
    span_tf = (hi_tf - lo_tf) or 1.0
    tfidf_norm = [(s - lo_tf) / span_tf for s in tfidf_vals]

    kb_vals = [kb_scores.get(c["term"], 0.0) for c in candidates]
    lo_kb, hi_kb = (min(kb_vals), max(kb_vals)) if kb_vals else (0.0, 1.0)
    span_kb = (hi_kb - lo_kb) or 1.0
    kb_norm = [(s - lo_kb) / span_kb for s in kb_vals]

    blended = []
    for i, c in enumerate(candidates):
        term = c["term"]
        if alpha <= 0.0:
            combined = kb_vals[i]
        elif alpha >= 1.0:
            combined = c["score"]
        else:
            combined = alpha * tfidf_norm[i] + (1 - alpha) * kb_norm[i]
        blended.append({
            "term": term,
            "score": float(combined),
            "tfidf_score": float(c["score"]),
            "keybert_score": float(kb_vals[i])
        })

    blended.sort(key=lambda x: x["score"], reverse=True)
    return blended

def main():
    try:
        data = json.load(sys.stdin)
        docs = data.get("docs", [])
        candidates = data.get("candidates", [])
        model_name = data.get("model_name", "allenai-specter")
        alpha_val = data.get("alpha")
        alpha = float(alpha_val) if alpha_val is not None else 0.1

        if not docs or not candidates:
            print(json.dumps({"keywords": candidates}))
            return

        blended = compute_keybert_scores(docs, candidates, model_name, alpha)
        print(json.dumps({"keywords": blended}))
    except Exception as e:
        sys.stderr.write(f"Error in KeyBERT scoring: {e}\n")
        json.dump({"error": str(e), "keywords": data.get("candidates", []) if "data" in locals() else []}, sys.stdout)

if __name__ == "__main__":
    main()
