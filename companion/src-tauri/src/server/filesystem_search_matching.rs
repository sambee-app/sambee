//! Name matching for live file-system search.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

const CASEFOLD_DATA: &str = include_str!("../../../../shared/filesystem-search/casefold.json");

#[derive(Deserialize)]
struct CasefoldData {
    casefold: Vec<(char, String)>,
}

fn casefold_table() -> &'static HashMap<char, String> {
    static TABLE: OnceLock<HashMap<char, String>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let data: CasefoldData = serde_json::from_str(CASEFOLD_DATA).expect("Embedded file-search case-folding data must be valid");
        data.casefold.into_iter().collect()
    })
}

fn append_folded(output: &mut Vec<char>, character: char, case_sensitive: bool) {
    if !case_sensitive {
        if let Some(value) = casefold_table().get(&character) {
            output.extend(value.chars());
            return;
        }
    }
    output.push(character);
}

#[derive(Debug)]
enum Token {
    Literal(Vec<char>),
    Any,
    Star,
}

/// A parsed query that matches base names without regular-expression backtracking.
pub struct NameMatcher {
    case_sensitive: bool,
    tokens: Vec<Token>,
    plain: bool,
}

impl NameMatcher {
    pub fn new(query: &str, case_sensitive: bool) -> Result<Self, &'static str> {
        if query.chars().all(super::directory_index::is_search_whitespace) {
            return Err("Enter a search term that is not empty or only whitespace.");
        }
        let mut tokens = Vec::new();
        let mut literal = Vec::new();
        let mut pattern = false;
        let mut characters = query.chars().peekable();
        while let Some(character) = characters.next() {
            if character == '\\' && characters.peek().is_some_and(|next| matches!(next, '*' | '?' | '\\')) {
                append_folded(&mut literal, characters.next().expect("peeked escape exists"), case_sensitive);
                continue;
            }
            if matches!(character, '*' | '?') {
                pattern = true;
                if !literal.is_empty() {
                    tokens.push(Token::Literal(std::mem::take(&mut literal)));
                }
                if character == '?' {
                    tokens.push(Token::Any);
                } else if !matches!(tokens.last(), Some(Token::Star)) {
                    tokens.push(Token::Star);
                }
            } else {
                append_folded(&mut literal, character, case_sensitive);
            }
        }
        if !literal.is_empty() {
            tokens.push(Token::Literal(literal));
        }
        Ok(Self {
            case_sensitive,
            tokens,
            plain: !pattern,
        })
    }

    pub fn matches(&self, name: &str) -> bool {
        let mut folded = Vec::new();
        let mut boundaries = vec![0];
        for character in name.chars() {
            append_folded(&mut folded, character, self.case_sensitive);
            boundaries.push(folded.len());
        }
        if self.plain {
            let Some(Token::Literal(literal)) = self.tokens.first() else {
                return false;
            };
            return folded.windows(literal.len()).any(|window| window == literal);
        }
        let mut positions = vec![None; folded.len() + 1];
        for (index, offset) in boundaries.iter().enumerate() {
            positions[*offset] = Some(index);
        }
        let name_length = boundaries.len() - 1;
        let mut name_position = 0;
        let mut token_position = 0;
        let mut star_position = None;
        let mut star_name_position = 0;
        while name_position < name_length {
            match self.tokens.get(token_position) {
                Some(Token::Any) => {
                    name_position += 1;
                    token_position += 1;
                    continue;
                }
                Some(Token::Literal(literal)) => {
                    let start = boundaries[name_position];
                    let end = start + literal.len();
                    if let Some(Some(next)) = positions.get(end) {
                        if folded.get(start..end) == Some(literal.as_slice()) {
                            name_position = *next;
                            token_position += 1;
                            continue;
                        }
                    }
                }
                Some(Token::Star) => {
                    star_position = Some(token_position);
                    star_name_position = name_position;
                    token_position += 1;
                    continue;
                }
                None => {}
            }
            let Some(star) = star_position else { return false };
            if star_name_position == name_length {
                return false;
            }
            star_name_position += 1;
            name_position = star_name_position;
            token_position = star + 1;
        }
        while matches!(self.tokens.get(token_position), Some(Token::Star)) {
            token_position += 1;
        }
        token_position == self.tokens.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = include_str!("../../../../shared/filesystem-search/matching-fixtures.json");

    #[test]
    fn shared_name_matching_fixtures() {
        let fixtures: serde_json::Value = serde_json::from_str(FIXTURES).unwrap();
        for query in fixtures["invalid_queries"].as_array().unwrap() {
            assert!(NameMatcher::new(query.as_str().unwrap(), false).is_err());
        }
        for case in fixtures["matches"].as_array().unwrap() {
            let query = case["query"].as_str().unwrap();
            let name = case["name"].as_str().unwrap();
            let matcher = NameMatcher::new(query, case["case_sensitive"].as_bool().unwrap()).unwrap();
            assert_eq!(matcher.matches(name), case["expected"].as_bool().unwrap(), "{query:?} / {name:?}");
        }
    }

    #[test]
    fn pathological_pattern_completes_without_backtracking() {
        let matcher = NameMatcher::new("*a*a*a*a*b", true).unwrap();
        assert!(!matcher.matches(&"a".repeat(10_000)));
    }
}
