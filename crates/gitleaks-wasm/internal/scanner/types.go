package scanner

type Side struct {
	Files         []File            `json:"files"`
	Config        string            `json:"config"`
	ConfigPresent bool              `json:"configPresent"`
	Ignore        string            `json:"ignore"`
	ConfigFiles   map[string]string `json:"configFiles"`
}

type File struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type ChangedFile struct {
	Path         string `json:"path"`
	PreviousPath string `json:"previousPath"`
	Status       string `json:"status"`
}

type LineRange [2]int

type Request struct {
	ComparisonID    string                 `json:"comparisonID"`
	BaseRevision    string                 `json:"baseRevision"`
	HeadRevision    string                 `json:"headRevision"`
	Salt            string                 `json:"salt"`
	Base            Side                   `json:"base"`
	Head            Side                   `json:"head"`
	ChangedFiles    []ChangedFile          `json:"changedFiles"`
	HeadChanges     map[string][]LineRange `json:"headChanges"`
	BaseComplete    bool                   `json:"baseComplete"`
	HeadComplete    bool                   `json:"headComplete"`
	ChangesComplete bool                   `json:"changesComplete"`
}

type Location struct {
	Path      string `json:"path"`
	StartLine int    `json:"startLine"`
	StartCol  int    `json:"startCol"`
	EndLine   int    `json:"endLine"`
	EndCol    int    `json:"endCol"`
}

type Finding struct {
	Rule        string   `json:"rule"`
	Description string   `json:"description"`
	Location    Location `json:"location"`
	Fingerprint string   `json:"fingerprint"`
	Masked      string   `json:"masked"`
	Entropy     *float32 `json:"entropy,omitempty"`
}

type UnclassifiedFinding struct {
	Finding
	Reason string `json:"reason"`
}

type InlineMatch struct {
	Rule        string `json:"rule"`
	Fingerprint string `json:"fingerprint"`
	Masked      string `json:"masked"`
}

type InlineAllow struct {
	Path    string        `json:"path"`
	Line    int           `json:"line"`
	Matches []InlineMatch `json:"matches"`
	Exact   bool          `json:"exact"`
}

type AllowlistFile struct {
	Path   string `json:"path"`
	Change string `json:"change"`
}

type AllowlistChange struct {
	Files   []AllowlistFile `json:"files"`
	Added   []string        `json:"added"`
	Total   int             `json:"total"`
	LeftOut int             `json:"leftOut"`
	Exact   bool            `json:"exact"`
}

type Result struct {
	ComparisonID string                `json:"comparisonID"`
	BaseRevision string                `json:"baseRevision"`
	HeadRevision string                `json:"headRevision"`
	Introduced   []Finding             `json:"introduced"`
	Unclassified []UnclassifiedFinding `json:"unclassified"`
	Inline       []InlineAllow         `json:"inline"`
	Allowlist    *AllowlistChange      `json:"allowlist,omitempty"`
}

type rawMatch struct {
	rule        string
	description string
	path        string
	startLine   int
	endLine     int
	startCol    int
	endCol      int
	entropy     float32
	hasEntropy  bool
	span        string
	masked      string
	fingerprint string
}
